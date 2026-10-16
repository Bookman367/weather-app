'use strict';

/**
 * Shared builders for Hero golden snapshots.
 * Tests compare builder output to committed *.golden.json files.
 * test/golden/generate.js is the only writer — npm test never regenerates.
 */

const { mock } = require('node:test');
const {
  PRODUCTS,
  scoreSprayConditions,
  calcWetBulbC,
  calcDeltaT,
  rhFromDewPoint,
  classifyDeltaT,
  deltaTtoF,
  normalizeOpenMeteo,
  scoreHourly,
  futureHoursFromNow,
  nowInSpotTimezone,
  currentSpotHourKey,
  hourOfDayFromTime,
  utcOffsetSecondsForTimezone,
  toISO8601
} = require('../../lib/spray-logic');
const SpraySettings = require('../../lib/spray-settings');
const SavedFields = require('../../lib/saved-fields');
const SunTimes = require('../../lib/sun-times');
const WindDisplay = require('../../lib/wind-display');
const UrlLocation = require('../../lib/url-location');
const {
  rollupDaily,
  applyViewWindows,
  getCacheKey,
  generateGrid,
  buildForecastUrl
} = require('../../api/spray-map');

const FROZEN_ISO = '2026-10-16T18:00:00.000Z';
const FROZEN_MS = Date.parse(FROZEN_ISO);
const LINCOLN = { lat: 40.8136, lon: -96.7026 };
const SCORE_SEED = 20260907;
const SCORE_HOUR_COUNT = 5000;
const PRODUCTS_UNDER_TEST = [
  'general',
  'Dicamba',
  'Roundup (Glyphosate)',
  'Detonate + 2,4-D'
];
const METHODS_UNDER_TEST = ['clarity', 'university'];

const LIMIT_FIXTURES = {
  none: undefined,
  'herbicide-drift': {
    name: 'Herbicide - drift sensitive',
    max_wind_mph: 8,
    max_gust_mph: 12,
    min_temp_f: 50,
    max_temp_f: 95,
    min_rh: 40,
    max_rh: 95,
    max_precip_pct: 20,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true
  },
  'hot-day': {
    name: 'Hot-day tight',
    max_wind_mph: 15,
    max_gust_mph: 20,
    min_temp_f: 50,
    max_temp_f: 80,
    min_rh: 30,
    max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true
  },
  humid: {
    name: 'Humid',
    max_wind_mph: 15,
    max_gust_mph: 20,
    min_temp_f: 50,
    max_temp_f: 95,
    min_rh: 30,
    max_rh: 70,
    max_precip_pct: 30,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true
  },
  'zero-gust': {
    name: 'Zero gust',
    max_wind_mph: 15,
    max_gust_mph: 0,
    min_temp_f: 50,
    max_temp_f: 95,
    min_rh: 30,
    max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true
  }
};

const LIMIT_NAMES = Object.keys(LIMIT_FIXTURES);
const STATUS_CODE = { favorable: 0, caution: 1, 'no-good': 2 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

function freezeJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return { $num: String(v) };
    return v;
  }));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function lerp(rng, min, max, digits) {
  const v = min + rng() * (max - min);
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function baseHour(overrides) {
  return Object.assign({
    temp_f: 72,
    wind_mph: 8,
    gust_mph: 10,
    rh: 50,
    precip_pct: 10,
    delta_t: 4,
    delta_t_f: 7.2,
    hour_of_day: 10,
    cloud_pct: 40
  }, overrides);
}

function buildScoreHours() {
  const hours = [];

  function push(overrides) {
    hours.push(baseHour(overrides));
  }

  // Wind sweep covering the 14/15 mph General edge (sensitivity proof).
  for (let wind = 0; wind <= 25; wind++) {
    for (const temp_f of [40, 50, 72, 95, 96]) {
      for (const hour_of_day of [2, 10]) {
        push({ wind_mph: wind, temp_f, hour_of_day, gust_mph: wind + 2 });
      }
    }
  }

  for (let gust = 0; gust <= 25; gust++) {
    for (const wind_mph of [8, 16]) {
      push({ gust_mph: gust, wind_mph });
    }
  }

  for (let rh = 0; rh <= 100; rh += 10) {
    for (const temp_f of [50, 72]) {
      push({ rh, temp_f });
    }
  }

  for (let precip_pct = 0; precip_pct <= 100; precip_pct += 10) {
    push({ precip_pct });
  }

  for (let tenths = 0; tenths <= 150; tenths += 5) {
    const delta_t = tenths / 10;
    for (const hour_of_day of [2, 10]) {
      for (const rh of [30, 50]) {
        push({ delta_t, delta_t_f: delta_t * 9 / 5, hour_of_day, rh, temp_f: 70 });
      }
    }
  }

  for (let hour_of_day = 0; hour_of_day <= 23; hour_of_day++) {
    for (const delta_t of [1, 4, 8, 11]) {
      push({ hour_of_day, delta_t, delta_t_f: delta_t * 9 / 5 });
    }
  }

  for (let cloud_pct = 0; cloud_pct <= 100; cloud_pct += 10) {
    for (const wind_mph of [3, 8]) {
      push({ cloud_pct, wind_mph, gust_mph: wind_mph + 1, delta_t: 1.5 });
    }
  }

  // Locked live-app cases from test/score-defaults.test.js
  const known = [
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, hour_of_day: 10, cloud_pct: 40 },
    { temp_f: 72, wind_mph: 16, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, hour_of_day: 10 },
    { temp_f: 72, wind_mph: 13, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, hour_of_day: 10 },
    { temp_f: 72, wind_mph: 8, gust_mph: 21, rh: 50, precip_pct: 10, delta_t: 4, hour_of_day: 10 },
    { temp_f: 40, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, hour_of_day: 10 },
    { temp_f: 96, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, hour_of_day: 10 },
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 20, precip_pct: 10, delta_t: 4, hour_of_day: 10 },
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 96, precip_pct: 10, delta_t: 4, hour_of_day: 10 },
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 40, delta_t: 4, hour_of_day: 10 },
    { temp_f: 72, wind_mph: 3, gust_mph: 4, rh: 50, precip_pct: 10, delta_t: 1, hour_of_day: 10, cloud_pct: 20 },
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, hour_of_day: 2 },
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 8, hour_of_day: 2 },
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 11, hour_of_day: 10 },
    { temp_f: 70, wind_mph: 8, gust_mph: 10, rh: 30, precip_pct: 10, delta_t: 10, hour_of_day: 10 },
    { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 0.5, hour_of_day: 10 }
  ];
  for (const row of known) {
    push(Object.assign({ delta_t_f: row.delta_t * 9 / 5 }, row));
  }

  const rng = mulberry32(SCORE_SEED);
  while (hours.length < SCORE_HOUR_COUNT) {
    const delta_t = lerp(rng, 0, 15, 1);
    push({
      temp_f: lerp(rng, 20, 115, 1),
      wind_mph: lerp(rng, 0, 25, 1),
      gust_mph: lerp(rng, 0, 35, 1),
      rh: Math.round(lerp(rng, 5, 100, 0)),
      precip_pct: Math.round(lerp(rng, 0, 100, 0)),
      delta_t,
      delta_t_f: Math.round(delta_t * 9 / 5 * 10) / 10,
      hour_of_day: Math.round(lerp(rng, 0, 23, 0)),
      cloud_pct: Math.round(lerp(rng, 0, 100, 0))
    });
  }

  return hours.slice(0, SCORE_HOUR_COUNT);
}

function intern(dict, index, value) {
  if (index.has(value)) return index.get(value);
  const i = dict.length;
  dict.push(value);
  index.set(value, i);
  return i;
}

function buildScoreMatrix() {
  const hours = buildScoreHours();
  const reasonDict = [];
  const reasonIndex = new Map();
  const productDict = [];
  const productIndex = new Map();
  const rows = [];

  for (const hour of hours) {
    for (const product of PRODUCTS_UNDER_TEST) {
      for (const method of METHODS_UNDER_TEST) {
        for (const limitName of LIMIT_NAMES) {
          const limits = LIMIT_FIXTURES[limitName];
          const result = scoreSprayConditions(hour, product, method, limits);
          rows.push([
            STATUS_CODE[result.status],
            result.reasons.map((r) => intern(reasonDict, reasonIndex, r)),
            intern(productDict, productIndex, result.product)
          ]);
        }
      }
    }
  }

  return freezeJson({
    seed: SCORE_SEED,
    hourCount: hours.length,
    products: PRODUCTS_UNDER_TEST,
    methods: METHODS_UNDER_TEST,
    limitNames: LIMIT_NAMES,
    generalMaxWindMph: PRODUCTS.general.max_wind_mph,
    reasonDict,
    productDict,
    rows
  });
}

function buildDeltaTTable() {
  const rows = [];

  for (let t = -10; t <= 45; t += 2.5) {
    for (let rh = 0; rh <= 100; rh += 5) {
      const tw = calcWetBulbC(t, rh);
      const dt = calcDeltaT(t, rh);
      rows.push({
        t,
        rh,
        dew: null,
        tw,
        dt,
        dtF: deltaTtoF(dt),
        rhFromDew: null,
        classify: classifyDeltaT(dt)
      });
    }
  }

  for (const t of [0, 10, 20, 30]) {
    for (const dew of [-5, 0, 5, 10, 15, t]) {
      const dt = calcDeltaT(t, null, dew);
      rows.push({
        t,
        rh: null,
        dew,
        tw: null,
        dt,
        dtF: deltaTtoF(dt),
        rhFromDew: rhFromDewPoint(t, dew),
        classify: classifyDeltaT(dt)
      });
    }
  }

  const edges = [
    { t: null, rh: 50, dew: null },
    { t: 20, rh: null, dew: null },
    { t: 20, rh: 'nope', dew: null },
    { t: 20, rh: 100, dew: null },
    { t: 20, rh: -5, dew: null },
    { t: 20, rh: 105, dew: null },
    { t: 20, rh: 50, dew: 0 },
    { t: 25, rh: 50, dew: 13.9 }
  ];
  for (const e of edges) {
    const dt = calcDeltaT(e.t, e.rh, e.dew);
    rows.push({
      t: e.t,
      rh: e.rh,
      dew: e.dew,
      tw: Number.isFinite(e.t) && Number.isFinite(Number(e.rh)) ? calcWetBulbC(e.t, Number(e.rh)) : null,
      dt,
      dtF: deltaTtoF(dt),
      rhFromDew: e.dew == null ? null : rhFromDewPoint(e.t, e.dew),
      classify: classifyDeltaT(dt)
    });
  }

  rows.push({
    t: null,
    rh: null,
    dew: null,
    tw: null,
    dt: null,
    dtF: deltaTtoF(null),
    rhFromDew: rhFromDewPoint(null, null),
    classify: classifyDeltaT(null)
  });

  return freezeJson({ rows });
}

function buildOpenMeteo7d() {
  const hourly = {
    time: [],
    temperature_2m: [],
    apparent_temperature: [],
    dew_point_2m: [],
    relative_humidity_2m: [],
    precipitation_probability: [],
    precipitation: [],
    cloud_cover: [],
    weather_code: [],
    wind_speed_10m: [],
    wind_gusts_10m: [],
    wind_direction_10m: [],
    soil_temperature_0cm: []
  };
  const daily = {
    time: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    apparent_temperature_max: [],
    apparent_temperature_min: [],
    precipitation_sum: [],
    precipitation_probability_max: [],
    weather_code: [],
    wind_speed_10m_max: [],
    wind_gusts_10m_max: [],
    wind_direction_10m_dominant: [],
    sunrise: [],
    sunset: []
  };

  for (let d = 0; d < 7; d++) {
    const date = `2026-10-${pad2(16 + d)}`;
    let dayMax = -Infinity;
    let dayMin = Infinity;
    let dayPrecip = 0;
    let dayPrecipChance = 0;
    let dayWindMax = 0;
    let dayGustMax = 0;
    let dayCode = 0;

    daily.sunrise.push(`${date}T07:${pad2(28 + d)}`);
    daily.sunset.push(`${date}T18:${pad2(42 - d)}`);

    for (let h = 0; h < 24; h++) {
      const diurnal = Math.sin(((h - 6) / 24) * Math.PI * 2);
      const temp = Math.round((52 + d * 2.5 + 18 * diurnal) * 10) / 10;
      const dew = Math.round((38 + d + 6 * diurnal) * 10) / 10;
      const rh = Math.max(20, Math.min(95, Math.round(62 - 18 * diurnal + (d % 3) * 4)));
      const wind = Math.round((6 + (d % 4) * 2.5 + Math.abs(diurnal) * 5 + (h === 14 ? 4 : 0)) * 10) / 10;
      const gust = Math.round((wind + 3 + (h % 5 === 0 ? 4 : 0)) * 10) / 10;
      const precipChance = d === 3 ? (h >= 14 && h <= 20 ? 45 : 15) : (d === 5 && h >= 16 ? 35 : 8);
      const precip = precipChance >= 40 ? 0.08 : precipChance >= 30 ? 0.02 : 0;
      const cloud = d === 3 ? 80 : d === 5 ? 55 : Math.round(25 + Math.abs(diurnal) * 15);
      const code = precipChance >= 40 ? 61 : cloud >= 70 ? 3 : cloud >= 40 ? 2 : 1;

      hourly.time.push(`${date}T${pad2(h)}:00`);
      hourly.temperature_2m.push(temp);
      hourly.apparent_temperature.push(Math.round((temp - 1) * 10) / 10);
      hourly.dew_point_2m.push(dew);
      hourly.relative_humidity_2m.push(rh);
      hourly.precipitation_probability.push(precipChance);
      hourly.precipitation.push(precip);
      hourly.cloud_cover.push(cloud);
      hourly.weather_code.push(code);
      hourly.wind_speed_10m.push(wind);
      hourly.wind_gusts_10m.push(gust);
      hourly.wind_direction_10m.push((180 + d * 20 + h * 5) % 360);
      hourly.soil_temperature_0cm.push(Math.round(temp - 4));

      if (temp > dayMax) dayMax = temp;
      if (temp < dayMin) dayMin = temp;
      dayPrecip += precip;
      if (precipChance > dayPrecipChance) dayPrecipChance = precipChance;
      if (wind > dayWindMax) dayWindMax = wind;
      if (gust > dayGustMax) dayGustMax = gust;
      dayCode = code;
    }

    daily.time.push(date);
    daily.temperature_2m_max.push(dayMax);
    daily.temperature_2m_min.push(dayMin);
    daily.apparent_temperature_max.push(dayMax - 1);
    daily.apparent_temperature_min.push(dayMin - 1);
    daily.precipitation_sum.push(Math.round(dayPrecip * 100) / 100);
    daily.precipitation_probability_max.push(dayPrecipChance);
    daily.weather_code.push(dayCode);
    daily.wind_speed_10m_max.push(dayWindMax);
    daily.wind_gusts_10m_max.push(dayGustMax);
    daily.wind_direction_10m_dominant.push((180 + d * 20) % 360);
  }

  return freezeJson({
    latitude: LINCOLN.lat,
    longitude: LINCOLN.lon,
    generationtime_ms: 0,
    utc_offset_seconds: -18000,
    timezone: 'America/Chicago',
    timezone_abbreviation: 'CDT',
    elevation: 358,
    hourly_units: {
      time: 'iso8601',
      temperature_2m: '°F',
      wind_speed_10m: 'mph'
    },
    hourly,
    daily_units: {
      time: 'iso8601',
      sunrise: 'iso8601',
      sunset: 'iso8601'
    },
    daily
  });
}

function mockOpenMeteoFetch(fixture) {
  return async function mockedFetch(url) {
    const href = String(url);
    if (href.includes('api.open-meteo.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => structuredClone(fixture)
      };
    }
    throw new Error('Golden tests must not hit the network: ' + href);
  };
}

function createMockRes() {
  const captured = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false
  };
  const res = {
    setHeader(key, value) {
      captured.headers[key] = value;
    },
    status(code) {
      captured.statusCode = code;
      return res;
    },
    json(body) {
      captured.body = body;
      return res;
    },
    end() {
      captured.ended = true;
      return res;
    }
  };
  return { res, captured };
}

function withFrozenClock(fn) {
  const prevRandom = Math.random;
  mock.timers.enable({ apis: ['Date'], now: FROZEN_MS });
  Math.random = () => 0.123456789;
  try {
    return fn();
  } finally {
    Math.random = prevRandom;
    mock.timers.reset();
  }
}

async function withFrozenClockAndFetch(fn) {
  const prevFetch = global.fetch;
  const prevRandom = Math.random;
  const fixture = buildOpenMeteo7d();
  mock.timers.enable({ apis: ['Date'], now: FROZEN_MS });
  Math.random = () => 0.123456789;
  global.fetch = mockOpenMeteoFetch(fixture);
  try {
    return await fn({ fixture });
  } finally {
    global.fetch = prevFetch;
    Math.random = prevRandom;
    mock.timers.reset();
  }
}

async function buildSprayWindowGolden() {
  const handler = require('../../api/spray-window');
  return withFrozenClockAndFetch(async () => {
    const { res, captured } = createMockRes();
    await handler({
      method: 'GET',
      query: { lat: String(LINCOLN.lat), lon: String(LINCOLN.lon) }
    }, res);
    return freezeJson({
      frozenAt: FROZEN_ISO,
      location: LINCOLN,
      statusCode: captured.statusCode,
      headers: captured.headers,
      ended: captured.ended,
      body: captured.body
    });
  });
}

async function buildForecastGolden() {
  const handler = require('../../api/forecast');
  return withFrozenClockAndFetch(async () => {
    const { res, captured } = createMockRes();
    await handler({
      method: 'GET',
      query: {
        lat: String(LINCOLN.lat),
        lon: String(LINCOLN.lon),
        source: 'open-meteo',
        herbicide: 'general',
        method: 'clarity'
      }
    }, res);
    return freezeJson({
      frozenAt: FROZEN_ISO,
      location: LINCOLN,
      statusCode: captured.statusCode,
      headers: captured.headers,
      ended: captured.ended,
      body: captured.body
    });
  });
}

function buildSprayMapGolden() {
  const raw = buildOpenMeteo7d();
  const norm = normalizeOpenMeteo(raw, 168);
  const scored = scoreHourly(norm.hourly.map((h) => ({ ...h })), 'general', 'clarity');
  const sunByDate = SunTimes.indexDailySun(norm.daily);
  const windLimits = {
    max_wind_mph: PRODUCTS.general.max_wind_mph,
    max_gust_mph: PRODUCTS.general.max_gust_mph
  };
  const rollupOptions = {
    lat: LINCOLN.lat,
    lon: LINCOLN.lon,
    utcOffsetSeconds: raw.utc_offset_seconds,
    sunByDate,
    windLimits
  };
  const rollup = rollupDaily(scored, rollupOptions);
  const windows = applyViewWindows(scored, rollupOptions);
  const url = buildForecastUrl('40.8136,40.85', '-96.7026,-96.65');

  return freezeJson({
    rollup,
    applyViewWindows: {
      hourly: windows.hourly.map((h) => ({
        time: h.time,
        status: h.spray && h.spray.status,
        reasons: h.spray && h.spray.reasons,
        wind_mph: h.wind_mph,
        gust_mph: h.gust_mph,
        temp_f: h.temp_f,
        rh: h.rh,
        delta_t: h.delta_t,
        precip_pct: h.precip_pct
      })),
      daily: windows.daily
    },
    cacheKeys: {
      lincoln30general: getCacheKey(40.8136, -96.7026, 30, 'general'),
      lincolnNearby: getCacheKey(40.81, -96.70, 30, 'general'),
      lincoln60general: getCacheKey(40.8136, -96.7026, 60, 'general'),
      lincoln30dicamba: getCacheKey(40.8136, -96.7026, 30, 'Dicamba'),
      tzChicago: getCacheKey(41.0, -102.05, 30, 'general', 'America/Chicago'),
      tzDenver: getCacheKey(41.0, -102.05, 30, 'general', 'America/Denver')
    },
    generateGrid: {
      r30: generateGrid(LINCOLN.lat, LINCOLN.lon, 30, 7),
      r60: generateGrid(LINCOLN.lat, LINCOLN.lon, 60, 7)
    },
    buildForecastUrl: {
      url,
      params: Object.fromEntries(new URL(url).searchParams)
    }
  });
}

function buildStoresGolden() {
  return withFrozenClock(() => {
    const customRaw = {
      schemaVersion: 1,
      app: 'hero',
      kind: 'spray-settings',
      scope: 'user',
      jobId: null,
      fieldId: null,
      activeId: 'custom-fixed',
      settings: [
        {
          id: 'custom-fixed',
          name: 'Herbicide - drift sensitive',
          limits: { max_wind_mph: 8, max_gust_mph: 12, min_rh: 40 },
          notes: 'Named setting fixture',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    };

    const fieldsRaw = {
      schemaVersion: 99,
      fields: [
        {
          id: 'field-north',
          name: ' North 80 ',
          lat: 42.387561,
          lon: -97.778372,
          acres: 80.259,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        { id: 'field-north', name: 'Dup', lat: 41, lon: -97 },
        { name: '', lat: 40, lon: -96 },
        { name: 'Bad lat', lat: 200, lon: -96 },
        { name: 'Home', lat: 40.8, lon: -96.7, acres: -4 }
      ],
      activeId: 'field-north'
    };

    return freezeJson({
      frozenAt: FROZEN_ISO,
      spraySettings: {
        empty: SpraySettings.emptyDocument(),
        normalizeNull: SpraySettings.normalizeDocument(null),
        normalizeCustom: SpraySettings.normalizeDocument(customRaw),
        exportEmpty: SpraySettings.exportDocument(SpraySettings.emptyDocument()),
        exportCustom: SpraySettings.exportDocument(customRaw)
      },
      savedFields: {
        empty: SavedFields.emptyDocument(),
        normalizeNull: SavedFields.normalizeDocument(null),
        normalizeDocument: SavedFields.normalizeDocument(fieldsRaw),
        normalizeFieldAssigned: SavedFields.normalizeField({
          id: 'field-north',
          name: ' North 80 ',
          lat: 42.387561,
          lon: -97.778372,
          acres: 80.259,
          createdAt: '2026-01-01T00:00:00.000Z'
        }),
        normalizeFieldGenerated: SavedFields.normalizeField({
          name: 'South 40',
          lat: 41.1,
          lon: -96.2,
          acres: 40
        })
      }
    });
  });
}

function hourIso(date, hour) {
  return `${date}T${pad2(hour)}:00`;
}

function buildSunTimesGolden() {
  const solstice = { sunrise: '2024-06-21T05:16', sunset: '2024-06-21T20:29' };
  const winter = { sunrise: '2024-12-21T07:15', sunset: '2024-12-21T16:23' };
  const spring = { sunrise: '2026-03-08T06:12', sunset: '2026-03-08T18:01' };
  const fall = { sunrise: '2026-11-01T06:28', sunset: '2026-11-01T16:52' };
  const wrap = { sunrise: '2024-06-21T23:00', sunset: '2024-06-21T00:30' };

  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(hourIso('2024-06-21', h));

  return freezeJson({
    format: [
      solstice.sunrise,
      solstice.sunset,
      winter.sunrise,
      winter.sunset,
      '2024-06-21T00:05',
      '2024-06-21T12:00',
      '2024-06-21T12:00:00',
      '2024-06-21T00:00',
      null,
      '',
      'N/A',
      '2024-06-21',
      'not-a-time'
    ].map((iso) => ({
      iso,
      parse: SunTimes.parseOpenMeteoLocal(iso),
      long: SunTimes.formatSunTime(iso),
      short: SunTimes.formatSunTimeShort(iso)
    })),
    daylight: {
      solstice: hours.map((iso) => Object.assign({ iso }, SunTimes.classifyHourSun(iso, solstice.sunrise, solstice.sunset))),
      winter: [4, 7, 12, 16, 17].map((h) => {
        const iso = hourIso('2024-12-21', h);
        return Object.assign({ iso }, SunTimes.classifyHourSun(iso, winter.sunrise, winter.sunset));
      }),
      spring: [2, 6, 7, 18].map((h) => {
        const iso = hourIso('2026-03-08', h);
        return Object.assign({ iso }, SunTimes.classifyHourSun(iso, spring.sunrise, spring.sunset));
      }),
      fall: [1, 6, 12, 16].map((h) => {
        const iso = hourIso('2026-11-01', h);
        return Object.assign({ iso }, SunTimes.classifyHourSun(iso, fall.sunrise, fall.sunset));
      }),
      wrap: [0, 12, 23].map((h) => {
        const iso = hourIso('2024-06-21', h);
        return Object.assign({ iso }, SunTimes.classifyHourSun(iso, wrap.sunrise, wrap.sunset));
      }),
      missing: SunTimes.classifyHourSun('2024-06-21T12:00', null, null)
    },
    index: SunTimes.indexDailySun([
      {
        date: '2024-06-21',
        sunrise: solstice.sunrise,
        sunset: solstice.sunset,
        wind_dir: 'SW',
        wind_dir_deg: 225
      },
      { time: '2024-06-22', sunrise: 'N/A', sunset: '' }
    ]),
    sunForDate: {
      hit: SunTimes.sunForDate({
        '2024-06-21': { sunrise: solstice.sunrise, sunset: solstice.sunset }
      }, '2024-06-21T14:00'),
      miss: SunTimes.sunForDate({ '2024-06-21': { sunrise: solstice.sunrise } }, '2024-06-23')
    }
  });
}

function buildWindDisplayGolden() {
  const general = {
    max_wind_mph: PRODUCTS.general.max_wind_mph,
    max_gust_mph: PRODUCTS.general.max_gust_mph
  };
  const dicamba = {
    max_wind_mph: PRODUCTS.Dicamba.max_wind_mph,
    max_gust_mph: PRODUCTS.Dicamba.max_gust_mph
  };
  const zeroGust = { max_wind_mph: 15, max_gust_mph: 0 };
  const winds = [null, 0, 3, 8, 12, 13, 14, 15, 16, 20];
  const gusts = [null, 0, 10, 15, 20, 21];
  const degs = [null, '', 0, 11.2, 22.5, 45, 90, 180, 270, 315, 337.5, 360, -45, 405, 'NW', 'nw'];

  const drift = [];
  for (const [name, limits] of [
    ['general', general],
    ['dicamba', dicamba],
    ['zero-gust', zeroGust],
    ['none', null]
  ]) {
    for (const wind of winds) {
      for (const gust of gusts) {
        drift.push({
          name,
          wind,
          gust,
          risk: WindDisplay.driftRiskFromLimits(wind, gust, limits)
        });
      }
    }
  }

  return freezeJson({
    generalMaxWindMph: PRODUCTS.general.max_wind_mph,
    compass: degs.map((deg) => ({
      deg,
      compass: WindDisplay.degToCompass(deg),
      arrow: WindDisplay.arrowDeg(deg)
    })),
    drift,
    describe: [
      WindDisplay.describeWind(8, 12, 315, general),
      WindDisplay.describeWind(16, 10, 180, general),
      WindDisplay.describeWind(null, null, null, general),
      WindDisplay.describeWind(8, 10, 90, null)
    ]
  });
}

function buildUrlLocationGolden() {
  const searches = [
    '?lat=42.38756&lon=-97.77837&name=North%2080',
    'lat=42.38756&lon=-97.77837',
    '?lat=91&lon=-97.77837',
    '?lat=42.38756&lon=-181',
    '?lat=nope&lon=-97.77837',
    '?lat=42.38756',
    '?lon=-97.77837',
    '?name=North%2080',
    '',
    '?lat=40.8136&lon=-96.7026',
    '?lat=-90&lon=-180&name=edge',
    '?lat=90&lon=180',
    '?lat=0&lon=0&name=',
    new URLSearchParams('lat=42.38756&lon=-97.77837&name=North 80')
  ];

  const queries = [
    { lat: 42.38756, lon: -97.77837, name: '   ' },
    { lat: ['42.38756'], lon: ['-97.77837'], name: ['North 80'] },
    { lat: 42.38756, lon: -97.77837, name: 'North 80' },
    { lat: '', lon: '-97.77837' },
    null
  ];

  return freezeJson({
    fromSearch: searches.map((search) => ({
      search: search instanceof URLSearchParams ? search.toString() : search,
      result: UrlLocation.fromSearch(search)
    })),
    fromQuery: queries.map((query) => ({
      query,
      result: UrlLocation.fromQuery(query)
    }))
  });
}

function naiveHours(date) {
  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push({ time: `${date}T${pad2(h)}:00` });
  }
  return hours;
}

function buildSpotTimeGolden() {
  const cdtNow = new Date('2026-10-16T18:37:00.000Z');
  const fallBefore = new Date('2026-11-01T06:30:00.000Z');
  const fallAfter = new Date('2026-11-01T07:30:00.000Z');
  const springBefore = new Date('2026-03-08T07:30:00.000Z');
  const springAfter = new Date('2026-03-08T08:30:00.000Z');
  const chicago = { timezone: 'America/Chicago', utcOffsetSeconds: -18000 };
  const denver = { timezone: 'America/Denver', utcOffsetSeconds: -21600 };
  const octHours = naiveHours('2026-10-16');

  function pack(now, tzInfo, hours) {
    const future = futureHoursFromNow(hours, now, tzInfo);
    return {
      now: now.toISOString(),
      nowInSpot: nowInSpotTimezone(now, tzInfo),
      hourKey: currentSpotHourKey(now, tzInfo),
      offset: utcOffsetSecondsForTimezone(tzInfo.timezone, now),
      futureFirst: future[0] ? future[0].time : null,
      futureLength: future.length,
      futureTimes: future.map((h) => h.time)
    };
  }

  return freezeJson({
    hourOfDay: [
      '2026-10-16T13:00',
      '2026-10-16T00:00',
      '2026-10-16T23:00:00-05:00',
      'not-a-time',
      ''
    ].map((time) => ({ time, hour: hourOfDayFromTime(time) })),
    toISO8601: {
      naiveCdt: toISO8601('2026-10-16T13:00', -18000),
      naiveWithSeconds: toISO8601('2026-10-16T13:00:00', -18000),
      alreadyOffset: toISO8601('2026-10-16T13:00:00-05:00', -18000)
    },
    chicagoOct: pack(cdtNow, chicago, octHours),
    denverOct: pack(cdtNow, denver, octHours),
    chicagoFallBefore: pack(fallBefore, { timezone: 'America/Chicago', utcOffsetSeconds: -18000 }, naiveHours('2026-11-01')),
    chicagoFallAfter: pack(fallAfter, { timezone: 'America/Chicago', utcOffsetSeconds: -21600 }, naiveHours('2026-11-01')),
    chicagoSpringBefore: pack(springBefore, { timezone: 'America/Chicago', utcOffsetSeconds: -21600 }, naiveHours('2026-03-08')),
    chicagoSpringAfter: pack(springAfter, { timezone: 'America/Chicago', utcOffsetSeconds: -18000 }, naiveHours('2026-03-08'))
  });
}

function stringifyGolden(filename, data) {
  if (filename.endsWith('score-matrix.golden.json')) {
    return JSON.stringify(data) + '\n';
  }
  return JSON.stringify(data, null, 2) + '\n';
}

module.exports = {
  FROZEN_ISO,
  FROZEN_MS,
  LINCOLN,
  PRODUCTS_UNDER_TEST,
  METHODS_UNDER_TEST,
  LIMIT_FIXTURES,
  LIMIT_NAMES,
  freezeJson,
  stringifyGolden,
  withFrozenClock,
  withFrozenClockAndFetch,
  buildScoreHours,
  buildScoreMatrix,
  buildDeltaTTable,
  buildOpenMeteo7d,
  buildSprayWindowGolden,
  buildForecastGolden,
  buildSprayMapGolden,
  buildStoresGolden,
  buildSunTimesGolden,
  buildWindDisplayGolden,
  buildUrlLocationGolden,
  buildSpotTimeGolden
};

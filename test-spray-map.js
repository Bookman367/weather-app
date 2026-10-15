const assert = require('assert');
const {
  generateGrid,
  buildForecastUrl,
  FORECAST_DAYS,
  HOURLY_LIMIT,
  CACHE_TTL_MS,
  getCacheKey,
  majorityDayStatus,
  worstCaseStatus,
  findBestWindow,
  daytimeHours,
  rollupDaily,
  formatHourShort
} = require('./api/spray-map.js');
const { scoreHourly, normalizeOpenMeteo } = require('./lib/spray-logic.js');

function hour(time, status, extras = {}) {
  return { time, status, reasons: extras.reasons || [], ...extras };
}

function makeRawHours(count) {
  const time = [];
  const fill = (n) => Array(count).fill(n);
  for (let i = 0; i < count; i++) {
    const day = 1 + Math.floor(i / 24);
    const hr = String(i % 24).padStart(2, '0');
    time.push(`2023-10-${String(day).padStart(2, '0')}T${hr}:00`);
  }
  return {
    hourly: {
      time,
      temperature_2m: fill(75),
      apparent_temperature: fill(75),
      dew_point_2m: fill(50),
      relative_humidity_2m: fill(50),
      precipitation_probability: fill(0),
      precipitation: fill(0),
      cloud_cover: fill(20),
      weather_code: fill(0),
      wind_speed_10m: fill(10),
      wind_gusts_10m: fill(15),
      wind_direction_10m: fill(180),
      soil_temperature_0cm: fill(60)
    },
    daily: {
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
    },
    timezone: 'America/Chicago',
    utc_offset_seconds: -18000
  };
}

async function runTests() {
  let passed = 0;
  function check(name, fn) {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  }

  console.log('Running spray-map tests...');

  check('grid generation', () => {
    const lat = 42.35;
    const lon = -97.79;
    const radius = 30;
    const gridSize = 7;
    const grid = generateGrid(lat, lon, radius, gridSize);
    assert.strictEqual(grid.length, gridSize * gridSize, `Grid should have ${gridSize * gridSize} points`);
    const firstPoint = grid[0];
    assert(firstPoint.lat > 0, 'Latitude should be positive');
    assert(firstPoint.lon < 0, 'Longitude should be negative');
    assert.strictEqual(firstPoint.bounds.length, 2, 'Should have 2 bounds elements (min/max)');
  });

  check('hourly scoring mock uses Hero spray object', () => {
    const mockHourly = [{
      time: '2023-10-01T12:00',
      hour_of_day: 12,
      temp_f: 75,
      wind_mph: 10,
      gust_mph: 15,
      rh: 50,
      delta_t: 5,
      delta_t_f: 9,
      precip_pct: 0
    }];
    const scored = scoreHourly(mockHourly, 'general', 'clarity');
    assert(scored[0].spray, 'Should have a spray object attached');
    assert.strictEqual(scored[0].spray.status, 'favorable', 'Status should be favorable for optimal conditions');
  });

  check('Open-Meteo request asks for 7 days / 168 hours in one batched URL', () => {
    assert.strictEqual(FORECAST_DAYS, 7);
    assert.strictEqual(HOURLY_LIMIT, 168);
    const url = buildForecastUrl('42.35,42.4', '-97.79,-97.7');
    assert(url.includes('forecast_days=7'), 'URL must request 7 forecast days');
    assert(!url.includes('forecast_days=2'), 'URL must not still request 2 days');
    assert(url.includes('latitude=42.35,42.4'), 'URL must batch multiple latitudes');
    assert(url.includes('longitude=-97.79,-97.7'), 'URL must batch multiple longitudes');
    assert.strictEqual(url.indexOf('https://api.open-meteo.com/v1/forecast'), 0);
  });

  check('normalizeOpenMeteo default stays 96; 168-hour window is opt-in', () => {
    const raw = makeRawHours(168);
    const defaultNorm = normalizeOpenMeteo(raw);
    assert.strictEqual(defaultNorm.hourly.length, 96, 'Default cap stays 96 for the main forecast');
    const weekNorm = normalizeOpenMeteo(raw, HOURLY_LIMIT);
    assert.strictEqual(weekNorm.hourly.length, 168, 'Spray map can normalize a full 7-day hourly set');
  });

  check('in-memory cache key and TTL are unchanged', () => {
    assert.strictEqual(CACHE_TTL_MS, 15 * 60 * 1000);
    const a = getCacheKey(42.351, -97.791, 30, 'general');
    const b = getCacheKey(42.349, -97.789, 30, 'general');
    assert.strictEqual(a, b, 'Nearby coordinates should share a cache key');
    const c = getCacheKey(42.35, -97.79, 60, 'general');
    assert.notStrictEqual(a, c, 'Different radius must not share a cache key');
    const d = getCacheKey(42.35, -97.79, 30, 'Dicamba');
    assert.notStrictEqual(a, d, 'Different product must not share a cache key');
    assert.strictEqual(a.split('_').length, 4, 'Cache key shape is lat_lon_radius_product');
  });

  check('majority-rule daily status matches Hero forecast.js', () => {
    const go = hour('2023-10-01T08:00', 'favorable');
    const caution = hour('2023-10-01T09:00', 'caution');
    const nogo = hour('2023-10-01T10:00', 'no-good');
    assert.strictEqual(majorityDayStatus([go, go, caution]), 'favorable');
    assert.strictEqual(majorityDayStatus([caution, caution, go]), 'caution');
    assert.strictEqual(majorityDayStatus([nogo, nogo, caution]), 'no-good');
    assert.strictEqual(majorityDayStatus([go, go, nogo, nogo]), 'caution', 'go tied with no-go → caution');
    assert.strictEqual(majorityDayStatus([caution, caution, nogo, nogo]), 'no-good', 'caution tied with no-go → no-go');
    assert.strictEqual(majorityDayStatus([]), 'favorable');
  });

  check('worst-case rating and best Go window', () => {
    const hours = [
      hour('2023-10-01T06:00', 'caution'),
      hour('2023-10-01T07:00', 'favorable'),
      hour('2023-10-01T08:00', 'favorable'),
      hour('2023-10-01T09:00', 'favorable'),
      hour('2023-10-01T10:00', 'no-good'),
      hour('2023-10-01T11:00', 'favorable'),
      hour('2023-10-01T12:00', 'favorable')
    ];
    assert.strictEqual(worstCaseStatus(hours), 'no-good');
    const best = findBestWindow(hours, 'favorable');
    assert(best, 'Should find a Go window');
    assert.strictEqual(best.hours, 3);
    assert.strictEqual(best.start, '2023-10-01T07:00');
    assert.strictEqual(best.end, '2023-10-01T09:00');
    assert.strictEqual(best.startLabel, '7a');
    assert.strictEqual(best.endLabel, '9a');
    assert.strictEqual(formatHourShort('2023-10-01T16:00'), '4p');
  });

  check('daytimeHours keeps sunrise → sunset+2h (Hero default)', () => {
    const hours = [
      hour('2023-10-01T05:00', 'favorable'),
      hour('2023-10-01T07:00', 'favorable'),
      hour('2023-10-01T12:00', 'favorable'),
      hour('2023-10-01T19:00', 'favorable'),
      hour('2023-10-01T21:00', 'favorable')
    ];
    const filtered = daytimeHours(hours, '6:00 AM', '7:00 PM', 0, 2);
    const times = filtered.map(h => h.time);
    assert.deepStrictEqual(times, [
      '2023-10-01T07:00',
      '2023-10-01T12:00',
      '2023-10-01T19:00',
      '2023-10-01T21:00'
    ]);
  });

  check('daily rollup: 7-day window, majority color, best window, Go hours, worst-case', () => {
    const hours = [];
    // Day 1: 10 Go + 2 Caution → majority Go, worst Caution, best window 10h
    for (let i = 6; i <= 17; i++) {
      const hr = String(i).padStart(2, '0');
      hours.push(hour(`2023-10-01T${hr}:00`, i <= 15 ? 'favorable' : 'caution', {
        temp: 70, wind: 8, gust: 12, rh: 45, precip: 5,
        reasons: i > 15 ? ['Wind approaching limit'] : []
      }));
    }
    // Day 2: 2 Go + 3 Caution + 7 No-Go → majority No-Go, best Go window 2h
    for (let i = 6; i <= 17; i++) {
      const hr = String(i).padStart(2, '0');
      let status = 'no-good';
      let reasons = ['Gusts exceed limit'];
      if (i === 8 || i === 9) { status = 'favorable'; reasons = []; }
      else if (i >= 10 && i <= 12) { status = 'caution'; reasons = ['RH high']; }
      hours.push(hour(`2023-10-02T${hr}:00`, status, {
        temp: 82, wind: 14, gust: 22, rh: 40, precip: 10, reasons
      }));
    }
    // Days 3–7: all No-Go so the rollup still covers a 7-day hourly set
    for (let d = 3; d <= 7; d++) {
      for (let i = 0; i < 24; i++) {
        const hr = String(i).padStart(2, '0');
        hours.push(hour(`2023-10-0${d}T${hr}:00`, 'no-good', {
          temp: 40, wind: 25, gust: 35, rh: 20, precip: 80,
          reasons: ['Temp IS 40°F — below minimum 50°F']
        }));
      }
    }

    assert(hours.length > 48, 'Fixture spans more than the old 48-hour window');
    const days = rollupDaily(hours);
    assert.strictEqual(days.length, 7, 'Should roll up 7 calendar days');

    const day1 = days[0];
    assert.strictEqual(day1.date, '2023-10-01');
    assert.strictEqual(day1.status, 'favorable', 'Majority of day 1 is Go');
    assert.strictEqual(day1.worstStatus, 'caution', 'Worst hour on day 1 is Caution');
    assert.strictEqual(day1.goCount, 10);
    assert.strictEqual(day1.bestWindow.hours, 10);
    assert.strictEqual(day1.bestWindow.startLabel, '6a');
    assert.strictEqual(day1.bestWindow.endLabel, '3p');
    assert.deepStrictEqual(day1.goHours.map(h => h.label).slice(0, 3), ['6a', '7a', '8a']);
    assert(day1.reasons.includes('Wind approaching limit'));

    const day2 = days[1];
    assert.strictEqual(day2.status, 'no-good', 'Majority of day 2 is No-Go');
    assert.strictEqual(day2.worstStatus, 'no-good');
    assert.strictEqual(day2.bestWindow.status, 'favorable');
    assert.strictEqual(day2.bestWindow.hours, 2);
    assert.strictEqual(day2.bestWindow.startLabel, '8a');
    assert.strictEqual(day2.bestWindow.endLabel, '9a');
    assert.strictEqual(day2.goCount, 2);
    assert.strictEqual(day2.tempMax, 82);
    assert.strictEqual(day2.wind, 14);
    assert.strictEqual(day2.gust, 22);
  });

  console.log(`All ${passed} tests passed!`);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

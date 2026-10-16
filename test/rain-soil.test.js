'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const RS = require('../lib/rain-soil');
const { normalizeOpenMeteo } = require('../lib/spray-logic');
const {
  NOW_LOCAL,
  TODAY,
  buildOpenMeteo,
  LINCOLN_AFTER_RAIN,
  LINCOLN_WET_TODAY,
  LINCOLN_DRY_SPELL
} = require('./fixtures/rain-soil');

describe('Open-Meteo rain/soil URL (no network)', () => {
  it('past_days=7 asks for daily precip and hourly soil layers with timezone=auto', () => {
    const url = RS.openMeteoPastDaysUrl(40.8136, -96.7026);
    assert.match(url, /past_days=7/);
    assert.match(url, /precipitation_sum/);
    assert.match(url, /soil_moisture_0_to_1cm/);
    assert.match(url, /soil_temperature_6cm/);
    assert.match(url, /timezone=auto/);
    assert.match(url, /precipitation_unit=inch/);
    assert.match(url, /temperature_unit=fahrenheit/);
    assert.equal(url.includes('score'), false);
  });
});

describe('moisture labels (documented VWC thresholds)', () => {
  it('dry < 0.15, moist 0.15–0.30, wet >= 0.30', () => {
    assert.equal(RS.MOISTURE_DRY_MAX, 0.15);
    assert.equal(RS.MOISTURE_WET_MIN, 0.30);
    assert.equal(RS.moistureLabel(0.149), 'dry');
    assert.equal(RS.moistureLabel(0.15), 'moist');
    assert.equal(RS.moistureLabel(0.299), 'moist');
    assert.equal(RS.moistureLabel(0.30), 'wet');
    assert.equal(RS.moistureLabel(null), null);
  });
});

describe('Lincoln fixture at frozen 2026-10-16T13:00 local', () => {
  it('sums 24h from hourly, 3d/7d from daily, days since rain > 0.1 in', () => {
    const row = RS.summarizeFromOpenMeteo(LINCOLN_AFTER_RAIN, NOW_LOCAL);
    assert.equal(row.available, true);
    // 24h window is > Oct 15 13:00 through Oct 16 13:00: 0.30 + 0.05.
    // The 0.10 at Oct 15 12:00 is outside the trailing 24h.
    assert.equal(row.rain_24h_in, 0.35);
    // 3 calendar days (14th–16th): 0 + 0.40 + 0.05
    assert.equal(row.rain_3d_in, 0.45);
    // 7 calendar days (10th–16th): 0.12 + 0.40 + 0.05
    assert.equal(row.rain_7d_in, 0.57);
    assert.equal(row.days_since_rain, 1);
    assert.equal(row.soil_temp_f, 58);
    assert.equal(row.soil_moisture, 0.22);
    assert.equal(row.soil_moisture_label, 'moist');
    assert.match(row.spray_note, /foliage is dry/);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'status'), false);
  });

  it('treats 0.1 in as not over the rain-day threshold', () => {
    const raw = buildOpenMeteo({
      dailyPrecip: { '2026-10-15': 0.1, '2026-10-16': 0 },
      hourlyPrecip: { '2026-10-15T18:00': 0.1 }
    });
    const row = RS.summarizeFromOpenMeteo(raw, NOW_LOCAL);
    assert.equal(row.days_since_rain, null);
    assert.equal(row.rain_3d_in, 0.1);
  });

  it('counts a rain day when daily sum is over 0.1 in, including today', () => {
    const row = RS.summarizeFromOpenMeteo(LINCOLN_WET_TODAY, NOW_LOCAL);
    assert.equal(row.days_since_rain, 0);
    assert.equal(row.rain_24h_in, 0.35);
    assert.equal(row.soil_moisture_label, 'wet');
    assert.match(row.spray_note, /foliage is dry/);
    assert.doesNotMatch(row.spray_note, /favorable|caution|no-good|no-go/i);
  });

  it('yesterday rain outside the trailing 24h still sets days-since and the two-day note', () => {
    const raw = buildOpenMeteo({
      dailyPrecip: { '2026-10-15': 0.25, '2026-10-16': 0 },
      hourlyPrecip: { '2026-10-15T08:00': 0.25 }
    });
    const row = RS.summarizeFromOpenMeteo(raw, NOW_LOCAL);
    assert.equal(row.rain_24h_in, 0);
    assert.equal(row.days_since_rain, 1);
    assert.match(row.spray_note, /last couple of days/);
  });

  it('dry spell: zeros, dry soil, lookback-clear note', () => {
    const row = RS.summarizeFromOpenMeteo(LINCOLN_DRY_SPELL, NOW_LOCAL);
    assert.equal(row.rain_24h_in, 0);
    assert.equal(row.rain_3d_in, 0);
    assert.equal(row.rain_7d_in, 0);
    assert.equal(row.days_since_rain, null);
    assert.equal(row.soil_moisture_label, 'dry');
    assert.equal(row.soil_temp_f, 64);
    assert.match(row.spray_note, /lookback is clear/);
  });
});

describe('naive local times, not Date() / process TZ', () => {
  it('maps a frozen UTC instant to naive local in the field timezone', () => {
    const now = new Date('2026-10-16T18:00:00.000Z');
    assert.equal(
      RS.nowLocalFromInstant(now, { timezone: 'America/Chicago', utcOffsetSeconds: -5 * 3600 }).slice(0, 16),
      '2026-10-16T13:00'
    );
    assert.equal(
      RS.nowLocalFromInstant(now, { utcOffsetSeconds: -5 * 3600 }).slice(0, 16),
      '2026-10-16T13:00'
    );
  });

  it('parses Open-Meteo wall-clock hours without using Date()', () => {
    const parts = RS.parseNaiveHour('2026-03-08T02:30');
    assert.equal(parts.hour, 2);
    assert.equal(parts.date, '2026-03-08');
    assert.equal(parts.hourKey, '2026-03-08T02:00');
    assert.equal(RS.parseNaiveHour('2026-10-16'), null);
    assert.equal(RS.addDaysYmd('2026-10-16', -1), '2026-10-15');
    assert.equal(RS.addDaysYmd('2026-03-01', -1), '2026-02-28');
  });

  it('uses the current local hour for soil, not a later forecast hour', () => {
    const raw = buildOpenMeteo({
      soilMoisture: {
        '2026-10-16T13:00': 0.18,
        '2026-10-16T14:00': 0.40
      },
      soilTempF: {
        '2026-10-16T13:00': 55,
        '2026-10-16T14:00': 99
      }
    });
    const row = RS.summarizeFromOpenMeteo(raw, NOW_LOCAL);
    assert.equal(row.soil_moisture, 0.18);
    assert.equal(row.soil_temp_f, 55);
    assert.equal(row.soil_moisture_label, 'moist');
  });

  it('does not shift totals when the process TZ changes', () => {
    const script = `
      const RS = require(${JSON.stringify(path.resolve(__dirname, '../lib/rain-soil.js'))});
      const { LINCOLN_AFTER_RAIN, NOW_LOCAL } = require(${JSON.stringify(path.resolve(__dirname, './fixtures/rain-soil.js'))});
      const row = RS.summarizeFromOpenMeteo(LINCOLN_AFTER_RAIN, NOW_LOCAL);
      if (row.rain_24h_in !== 0.35) { console.error('24h', row.rain_24h_in); process.exit(1); }
      if (row.days_since_rain !== 1) { console.error('days', row.days_since_rain); process.exit(2); }
      if (row.soil_temp_f !== 58) { console.error('soil', row.soil_temp_f); process.exit(3); }
    `;
    for (const tz of ['UTC', 'America/Chicago', 'America/New_York', 'Pacific/Auckland', 'Asia/Tokyo']) {
      const result = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${tz}: ${result.stderr || result.stdout}`);
    }
  });
});

describe('forecastWindow strips past_days before scoring', () => {
  it('starts hourly/daily at the local today, not seven days ago', () => {
    const sliced = RS.forecastWindow(LINCOLN_AFTER_RAIN, NOW_LOCAL);
    assert.equal(sliced.hourly.time[0], '2026-10-16T00:00');
    assert.equal(sliced.daily.time[0], TODAY);
    assert.ok(LINCOLN_AFTER_RAIN.hourly.time[0] < '2026-10-16T00:00');
    assert.equal(sliced.hourly.time.includes('2026-10-15T18:00'), false);
  });

  it('leaves normalizeOpenMeteo on a today-forward 96-hour window', () => {
    const sliced = RS.forecastWindow(LINCOLN_AFTER_RAIN, NOW_LOCAL);
    const padded = {
      ...sliced,
      hourly: {
        ...sliced.hourly,
        temperature_2m: sliced.hourly.time.map(() => 70),
        apparent_temperature: sliced.hourly.time.map(() => 70),
        dew_point_2m: sliced.hourly.time.map(() => 50),
        relative_humidity_2m: sliced.hourly.time.map(() => 50),
        precipitation_probability: sliced.hourly.time.map(() => 0),
        cloud_cover: sliced.hourly.time.map(() => 10),
        weather_code: sliced.hourly.time.map(() => 0),
        wind_speed_10m: sliced.hourly.time.map(() => 8),
        wind_gusts_10m: sliced.hourly.time.map(() => 10),
        wind_direction_10m: sliced.hourly.time.map(() => 180),
        soil_temperature_0cm: sliced.hourly.time.map(() => 60)
      },
      daily: {
        ...sliced.daily,
        temperature_2m_max: sliced.daily.time.map(() => 80),
        temperature_2m_min: sliced.daily.time.map(() => 55),
        apparent_temperature_max: sliced.daily.time.map(() => 80),
        apparent_temperature_min: sliced.daily.time.map(() => 55),
        precipitation_probability_max: sliced.daily.time.map(() => 0),
        weather_code: sliced.daily.time.map(() => 0),
        wind_speed_10m_max: sliced.daily.time.map(() => 12),
        wind_gusts_10m_max: sliced.daily.time.map(() => 18),
        wind_direction_10m_dominant: sliced.daily.time.map(() => 180),
        sunrise: sliced.daily.time.map(d => `${d}T07:32`),
        sunset: sliced.daily.time.map(d => `${d}T18:48`)
      }
    };
    const norm = normalizeOpenMeteo(padded);
    assert.equal(norm.hourly[0].time, '2026-10-16T00:00');
    assert.equal(norm.hourly.length, 96);
    assert.equal(norm.daily[0].date, TODAY);
  });
});

describe('display only — no spray score', () => {
  it('does not export scoring fields or go/caution/no-go notes', () => {
    assert.equal(RS.scoreSprayConditions, undefined);
    const empty = RS.emptySummary();
    assert.equal(empty.available, false);
    assert.doesNotMatch(empty.spray_note, /favorable|caution|no-good|no-go/i);
    const note = RS.sprayNote({
      rain_24h_in: 0.4,
      rain_3d_in: 0.4,
      days_since_rain: 0,
      soil_moisture_label: 'wet'
    });
    assert.doesNotMatch(note, /go\/caution|No-Go|favorable/i);
  });

  it('returns unavailable when payload or nowLocal is missing', () => {
    assert.equal(RS.summarizeFromOpenMeteo(null, NOW_LOCAL).available, false);
    assert.equal(RS.summarizeFromOpenMeteo(LINCOLN_AFTER_RAIN, 'not-a-time').available, false);
  });
});

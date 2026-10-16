'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('path');
const {
  futureHoursFromNow,
  nowInSpotTimezone,
  currentSpotHourKey,
  hourOfDayFromTime,
  utcOffsetSecondsForTimezone,
  toISO8601,
  calcSunriseSunset,
  normalizeOpenMeteo
} = require('../lib/spray-logic');
const { getCacheKey, applyViewWindows } = require('../api/spray-map.js');
const SunTimes = require('../lib/sun-times');

// US DST 2026: second Sunday in March / first Sunday in November.
const CHICAGO = 'America/Chicago';
const DENVER = 'America/Denver';
const CDT = -5 * 3600; // Central Daylight, Oct
const MDT = -6 * 3600; // Mountain Daylight, Oct
const CST = -6 * 3600; // Central Standard, after Nov 1 fall-back
const LINCOLN = { lat: 40.8136, lon: -96.7026 };

function naiveHours(date, startHour, endHour) {
  const hours = [];
  for (let h = startHour; h <= endHour; h++) {
    hours.push({ time: `${date}T${String(h).padStart(2, '0')}:00` });
  }
  return hours;
}

function firstTime(hours) {
  return hours.length ? hours[0].time : null;
}

describe('Open-Meteo naive local hours vs UTC now (the review bug)', () => {
  it('Central US: 1:37pm CDT is not compared as 1:37pm UTC', () => {
    // 18:37 UTC = 1:37pm CDT. Open-Meteo labels the 1pm block "…T13:00".
    const now = new Date('2026-10-16T18:37:00.000Z');
    const hourly = naiveHours('2026-10-16', 0, 23);

    // The bug (Vercel is UTC): Date("2026-10-16T13:00") is 13:00Z, already
    // "past" vs 18:37Z, so the strip skips the current hour by the CDT offset.
    const bugScript = `
      const now = new Date('2026-10-16T18:37:00.000Z');
      const hourly = [];
      for (let h = 0; h <= 23; h++) hourly.push({ time: '2026-10-16T' + String(h).padStart(2, '0') + ':00' });
      const first = hourly.filter(h => new Date(h.time) >= now)[0];
      if (!first || first.time !== '2026-10-16T19:00') {
        console.error(first && first.time); process.exit(1);
      }
    `;
    const bug = spawnSync(process.execPath, ['-e', bugScript], {
      env: { ...process.env, TZ: 'UTC' },
      encoding: 'utf8'
    });
    assert.equal(bug.status, 0, `UTC Date() compare: ${bug.stderr || bug.stdout}`);

    const future = futureHoursFromNow(hourly, now, {
      timezone: CHICAGO,
      utcOffsetSeconds: CDT
    });
    assert.equal(firstTime(future), '2026-10-16T13:00');
    assert.equal(future.length, 11, '13:00 through 23:00 inclusive');
    assert.ok(!future.some(h => h.time < '2026-10-16T13:00'), 'must drop true past hours');
  });

  it('Mountain US (different offset) starts the current hour, not UTC now', () => {
    // Same UTC instant = 12:37pm MDT.
    const now = new Date('2026-10-16T18:37:00.000Z');
    const hourly = naiveHours('2026-10-16', 0, 23);
    const future = futureHoursFromNow(hourly, now, {
      timezone: DENVER,
      utcOffsetSeconds: MDT
    });
    assert.equal(firstTime(future), '2026-10-16T12:00');
    assert.notEqual(
      firstTime(futureHoursFromNow(hourly, now, { timezone: CHICAGO, utcOffsetSeconds: CDT })),
      firstTime(future),
      'Central and Mountain current hours must not collapse to the same UTC hour'
    );
  });

  it('includes the current hour when now is 37 minutes past the hour', () => {
    const now = new Date('2026-10-16T18:37:00.000Z');
    const future = futureHoursFromNow(
      [{ time: '2026-10-16T13:00' }, { time: '2026-10-16T14:00' }],
      now,
      { timezone: CHICAGO, utcOffsetSeconds: CDT }
    );
    assert.equal(future[0].time, '2026-10-16T13:00');
  });
});

describe('now in the spot timezone (utc_offset_seconds / IANA)', () => {
  it('matches Open-Meteo CDT and MDT offsets at a known UTC instant', () => {
    const now = new Date('2026-10-16T18:37:00.000Z');
    assert.equal(nowInSpotTimezone(now, { utcOffsetSeconds: CDT }), '2026-10-16T13:37:00');
    assert.equal(nowInSpotTimezone(now, { timezone: CHICAGO, utcOffsetSeconds: CDT }), '2026-10-16T13:37:00');
    assert.equal(nowInSpotTimezone(now, { timezone: DENVER, utcOffsetSeconds: MDT }), '2026-10-16T12:37:00');
    assert.equal(currentSpotHourKey(now, { timezone: CHICAGO, utcOffsetSeconds: CDT }), '2026-10-16T13:00');
    assert.equal(utcOffsetSecondsForTimezone(CHICAGO, now), CDT);
    assert.equal(utcOffsetSecondsForTimezone(DENVER, now), MDT);
  });

  it('US fall-back 2026: 1:30 CDT then 1:30 CST after the repeated hour', () => {
    // 06:30Z = 1:30am CDT (before 2→1). 07:30Z = 1:30am CST (after the fallback).
    const before = new Date('2026-11-01T06:30:00.000Z');
    const after = new Date('2026-11-01T07:30:00.000Z');
    assert.equal(utcOffsetSecondsForTimezone(CHICAGO, before), CDT);
    assert.equal(nowInSpotTimezone(before, { timezone: CHICAGO, utcOffsetSeconds: CDT }), '2026-11-01T01:30:00');

    assert.equal(utcOffsetSecondsForTimezone(CHICAGO, after), CST);
    assert.equal(nowInSpotTimezone(after, { timezone: CHICAGO, utcOffsetSeconds: CST }), '2026-11-01T01:30:00');

    const hours = naiveHours('2026-11-01', 0, 5);
    assert.equal(firstTime(futureHoursFromNow(hours, before, { timezone: CHICAGO, utcOffsetSeconds: CDT })), '2026-11-01T01:00');
    assert.equal(firstTime(futureHoursFromNow(hours, after, { timezone: CHICAGO, utcOffsetSeconds: CST })), '2026-11-01T01:00');
  });

  it('US spring-forward 2026: current hour jumps 1:30 CST → 3:30 CDT', () => {
    const beforeJump = new Date('2026-03-08T07:30:00.000Z'); // 1:30am CST
    const afterJump = new Date('2026-03-08T08:30:00.000Z');  // 3:30am CDT (2am skipped)
    assert.equal(utcOffsetSecondsForTimezone(CHICAGO, beforeJump), CST);
    assert.equal(nowInSpotTimezone(beforeJump, { timezone: CHICAGO, utcOffsetSeconds: CST }), '2026-03-08T01:30:00');
    assert.equal(utcOffsetSecondsForTimezone(CHICAGO, afterJump), CDT);
    assert.equal(nowInSpotTimezone(afterJump, { timezone: CHICAGO, utcOffsetSeconds: CDT }), '2026-03-08T03:30:00');

    const hours = [
      { time: '2026-03-08T01:00' },
      { time: '2026-03-08T03:00' },
      { time: '2026-03-08T04:00' }
    ];
    assert.equal(firstTime(futureHoursFromNow(hours, beforeJump, { timezone: CHICAGO, utcOffsetSeconds: CST })), '2026-03-08T01:00');
    assert.equal(firstTime(futureHoursFromNow(hours, afterJump, { timezone: CHICAGO, utcOffsetSeconds: CDT })), '2026-03-08T03:00');
  });

  it('does not shift spot-local now when the process TZ changes', () => {
    const script = `
      const L = require(${JSON.stringify(path.resolve(__dirname, '../lib/spray-logic.js'))});
      const now = new Date('2026-10-16T18:37:00.000Z');
      const naive = L.nowInSpotTimezone(now, { timezone: 'America/Chicago', utcOffsetSeconds: ${CDT} });
      const hour = L.currentSpotHourKey(now, { timezone: 'America/Chicago', utcOffsetSeconds: ${CDT} });
      const future = L.futureHoursFromNow(
        [{ time: '2026-10-16T12:00' }, { time: '2026-10-16T13:00' }, { time: '2026-10-16T14:00' }],
        now,
        { timezone: 'America/Chicago', utcOffsetSeconds: ${CDT} }
      );
      if (naive !== '2026-10-16T13:37:00') { console.error('naive', naive); process.exit(1); }
      if (hour !== '2026-10-16T13:00') { console.error('hour', hour); process.exit(2); }
      if (!future[0] || future[0].time !== '2026-10-16T13:00') { console.error(future); process.exit(3); }
      if (L.hourOfDayFromTime('2026-10-16T13:00') !== 13) { process.exit(4); }
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

describe('hour_of_day and sunrise/sunset stay on the spot clock', () => {
  it('reads the hour from the Open-Meteo string, not Date().getHours()', () => {
    assert.equal(hourOfDayFromTime('2026-10-16T13:00'), 13);
    assert.equal(hourOfDayFromTime('2026-10-16T00:00'), 0);
    assert.equal(hourOfDayFromTime('2026-03-08T02:30'), 2);
    assert.equal(hourOfDayFromTime('2026-10-16T08:00:00-05:00'), 8);
    const raw = {
      hourly: {
        time: ['2026-10-16T13:00'],
        temperature_2m: [70],
        apparent_temperature: [70],
        dew_point_2m: [50],
        relative_humidity_2m: [50],
        precipitation_probability: [0],
        precipitation: [0],
        cloud_cover: [10],
        weather_code: [0],
        wind_speed_10m: [8],
        wind_gusts_10m: [10],
        wind_direction_10m: [180],
        soil_temperature_0cm: [60]
      },
      daily: {
        time: ['2026-10-16'],
        temperature_2m_max: [80],
        temperature_2m_min: [55],
        apparent_temperature_max: [80],
        apparent_temperature_min: [55],
        precipitation_sum: [0],
        precipitation_probability_max: [0],
        weather_code: [0],
        wind_speed_10m_max: [12],
        wind_gusts_10m_max: [18],
        wind_direction_10m_dominant: [180],
        sunrise: ['2026-10-16T07:32'],
        sunset: ['2026-10-16T18:48']
      },
      timezone: CHICAGO,
      utc_offset_seconds: CDT
    };
    const norm = normalizeOpenMeteo(raw);
    assert.equal(norm.hourly[0].hour_of_day, 13);
    assert.equal(norm.utcOffsetSeconds, CDT);
    assert.equal(norm.timezone, CHICAGO);
    assert.equal(SunTimes.formatSunTime(norm.daily[0].sunrise), '7:32 AM');
    assert.equal(SunTimes.formatSunTime(norm.daily[0].sunset), '6:48 PM');
  });

  it('calcSunriseSunset uses the Open-Meteo offset, not a hard-coded CST fallback', () => {
    const cdt = calcSunriseSunset(LINCOLN.lat, LINCOLN.lon, '2026-10-16', CDT);
    const cst = calcSunriseSunset(LINCOLN.lat, LINCOLN.lon, '2026-10-16', CST);
    assert.match(cdt.sunrise, /AM/);
    assert.match(cdt.sunset, /PM/);
    assert.notEqual(cdt.sunrise, cst.sunrise, 'CDT vs CST sunrise must differ by the DST hour');
    assert.notEqual(cdt.sunset, cst.sunset);
  });

  it('toISO8601 attaches the spot offset so Ops instants match local hours', () => {
    assert.equal(toISO8601('2026-10-16T13:00', CDT), '2026-10-16T13:00:00-05:00');
    assert.equal(toISO8601('2026-11-01T01:00', CST), '2026-11-01T01:00:00-06:00');
  });
});

describe('spray-map cache key does not mix timezones', () => {
  it('stays lat_lon_radius_product with no UTC timestamp', () => {
    const a = getCacheKey(42.351, -97.791, 30, 'general');
    assert.equal(a.split('_').length, 4);
    assert.equal(a.includes('T'), false, 'must not splice an ISO datetime into the key');
    assert.equal(a.includes('Z'), false, 'must not splice a UTC instant into the key');
    assert.equal(/^\d{4}-\d{2}-\d{2}/.test(a), false);
  });

  it('optional timezone distinguishes a TZ-border collision on the same rounded cell', () => {
    const chicago = getCacheKey(41.0, -102.05, 30, 'general', CHICAGO);
    const denver = getCacheKey(41.0, -102.05, 30, 'general', DENVER);
    assert.equal(getCacheKey(41.0, -102.05, 30, 'general'), getCacheKey(40.999, -102.051, 30, 'general'));
    assert.notEqual(chicago, denver);
    assert.ok(chicago.endsWith(CHICAGO));
    assert.ok(denver.endsWith(DENVER));
  });

  it('hourly strip and daily rollup start from the same spot-local current hour', () => {
    const now = new Date('2026-10-16T18:37:00.000Z');
    const scored = [];
    for (let d = 16; d <= 22; d++) {
      for (let h = 0; h < 24; h++) {
        scored.push({
          time: `2026-10-${d}T${String(h).padStart(2, '0')}:00`,
          status: 'favorable',
          reasons: [],
          temp: 70, wind: 8, gust: 10, rh: 50, precip: 5
        });
      }
    }
    const future = futureHoursFromNow(scored, now, {
      timezone: CHICAGO,
      utcOffsetSeconds: CDT,
      limit: 384
    });
    assert.equal(future[0].time, '2026-10-16T13:00');
    const windows = applyViewWindows(future);
    assert.equal(windows.hourly[0].time, '2026-10-16T13:00');
    assert.equal(windows.daily[0].date, '2026-10-16');
    assert.ok(windows.daily[0].hourCount < 24, 'today is a partial day starting at the current local hour');
  });
});

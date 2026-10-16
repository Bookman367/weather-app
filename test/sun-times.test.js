'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const S = require('../lib/sun-times');

// Published civil sunrise/sunset (timeanddate / USNO-style), encoded the
// way Open-Meteo daily fields look with timezone=auto: local, no Z.
// Chicago 41.85N, 87.65W.
const CHICAGO_SOLSTICE_2024 = {
  sunrise: '2024-06-21T05:16', // 5:16 AM CDT
  sunset: '2024-06-21T20:29'   // 8:29 PM CDT
};
const CHICAGO_WINTER_2024 = {
  sunrise: '2024-12-21T07:15', // 7:15 AM CST
  sunset: '2024-12-21T16:23'   // 4:23 PM CST
};

// US DST edges, 2026. Second Sunday in March / first Sunday in November.
const DST_SPRING = {
  date: '2026-03-08',
  sunrise: '2026-03-08T06:12', // ~6:12 AM CDT after the 2→3 jump
  sunset: '2026-03-08T18:01'
};
const DST_FALL = {
  date: '2026-11-01',
  sunrise: '2026-11-01T06:28', // ~6:28 AM CST after the 2→1 fallback
  sunset: '2026-11-01T16:52'
};

describe('Open-Meteo local sun-time parse / format', () => {
  it('formats known Chicago solstice and winter ISO fields', () => {
    assert.equal(S.formatSunTime(CHICAGO_SOLSTICE_2024.sunrise), '5:16 AM');
    assert.equal(S.formatSunTime(CHICAGO_SOLSTICE_2024.sunset), '8:29 PM');
    assert.equal(S.formatSunTimeShort(CHICAGO_SOLSTICE_2024.sunrise), '5:16a');
    assert.equal(S.formatSunTimeShort(CHICAGO_SOLSTICE_2024.sunset), '8:29p');
    assert.equal(S.formatSunTime(CHICAGO_WINTER_2024.sunrise), '7:15 AM');
    assert.equal(S.formatSunTime(CHICAGO_WINTER_2024.sunset), '4:23 PM');
    assert.equal(S.formatSunTimeShort(CHICAGO_WINTER_2024.sunset), '4:23p');
  });

  it('treats noon and midnight as 12-hour clock values', () => {
    assert.equal(S.formatSunTime('2024-06-21T00:05'), '12:05 AM');
    assert.equal(S.formatSunTime('2024-06-21T12:00'), '12:00 PM');
    assert.equal(S.formatSunTime('2024-06-21T12:00:00'), '12:00 PM');
    assert.equal(S.formatSunTimeShort('2024-06-21T00:00'), '12:00a');
  });

  it('rejects missing, N/A, and date-only values', () => {
    assert.equal(S.parseOpenMeteoLocal(null), null);
    assert.equal(S.parseOpenMeteoLocal(''), null);
    assert.equal(S.parseOpenMeteoLocal('N/A'), null);
    assert.equal(S.parseOpenMeteoLocal('2024-06-21'), null);
    assert.equal(S.formatSunTime('not-a-time'), null);
  });
});

describe('daylight windows and sunrise/sunset hour markers', () => {
  it('marks night before sunrise, day for any overlapping hour, night after sunset', () => {
    const rise = CHICAGO_SOLSTICE_2024.sunrise;
    const set = CHICAGO_SOLSTICE_2024.sunset;
    assert.equal(S.isDaylight('2024-06-21T04:00', rise, set), false);
    // 5:00–6:00 overlaps 5:16 sunrise — this is a daylight spraying hour.
    assert.equal(S.isDaylight('2024-06-21T05:00', rise, set), true);
    assert.equal(S.isDaylight('2024-06-21T05:16', rise, set), true);
    assert.equal(S.isDaylight('2024-06-21T12:00', rise, set), true);
    assert.equal(S.isDaylight('2024-06-21T20:00', rise, set), true);
    assert.equal(S.isDaylight('2024-06-21T21:00', rise, set), false);
    assert.equal(S.isDaylight('2024-06-21T23:00', rise, set), false);
  });

  it('tags the hour block that contains sunrise or sunset', () => {
    const rise = CHICAGO_SOLSTICE_2024.sunrise;
    const set = CHICAGO_SOLSTICE_2024.sunset;
    assert.equal(S.sunEventForHour('2024-06-21T05:00', rise, set), 'sunrise');
    assert.equal(S.sunEventForHour('2024-06-21T04:00', rise, set), null);
    assert.equal(S.sunEventForHour('2024-06-21T20:00', rise, set), 'sunset');
    assert.equal(S.sunEventForHour('2024-06-21T21:00', rise, set), null);
    assert.deepEqual(S.classifyHourSun('2024-06-21T05:00', rise, set), {
      daylight: true,
      sunEvent: 'sunrise'
    });
  });

  it('returns null daylight when polar / missing sun times', () => {
    assert.equal(S.isDaylight('2024-06-21T12:00', null, null), null);
    assert.equal(S.isDaylight('2024-06-21T12:00', 'N/A', 'N/A'), null);
    assert.equal(S.sunEventForHour('2024-06-21T12:00', null, '2024-06-21T20:00'), null);
  });

  it('treats sunset-before-sunrise as a midnight wrap (polar-style)', () => {
    // Artificial wrap: set 00:30, rise 23:00 → day is late night / early morning.
    assert.equal(S.isDaylight('2024-06-21T23:30', '2024-06-21T23:00', '2024-06-21T00:30'), true);
    assert.equal(S.isDaylight('2024-06-21T00:15', '2024-06-21T23:00', '2024-06-21T00:30'), true);
    assert.equal(S.isDaylight('2024-06-21T12:00', '2024-06-21T23:00', '2024-06-21T00:30'), false);
  });
});

describe('timezone and DST edges (wall-clock, not Date())', () => {
  it('keeps US spring-forward sunrise on the CDT side of the 2am jump', () => {
    const parts = S.parseOpenMeteoLocal(DST_SPRING.sunrise);
    assert.equal(parts.hour, 6);
    assert.equal(parts.minute, 12);
    assert.equal(S.formatSunTime(DST_SPRING.sunrise), '6:12 AM');
    assert.equal(S.formatSunTime(DST_SPRING.sunset), '6:01 PM');
    // The skipped 2:00–3:00 local hour must stay 2:30 if Open-Meteo emitted it.
    const skipped = S.parseOpenMeteoLocal('2026-03-08T02:30');
    assert.equal(skipped.hour, 2);
    assert.equal(skipped.minute, 30);
    assert.equal(S.isDaylight('2026-03-08T02:00', DST_SPRING.sunrise, DST_SPRING.sunset), false);
    assert.equal(S.isDaylight('2026-03-08T07:00', DST_SPRING.sunrise, DST_SPRING.sunset), true);
    assert.equal(S.sunEventForHour('2026-03-08T06:00', DST_SPRING.sunrise, DST_SPRING.sunset), 'sunrise');
  });

  it('keeps US fall-back sunrise on the CST side of the repeated 1am hour', () => {
    assert.equal(S.formatSunTime(DST_FALL.sunrise), '6:28 AM');
    assert.equal(S.formatSunTime(DST_FALL.sunset), '4:52 PM');
    const repeated = S.parseOpenMeteoLocal('2026-11-01T01:30');
    assert.equal(repeated.hour, 1);
    assert.equal(repeated.minute, 30);
    assert.equal(S.isDaylight('2026-11-01T01:00', DST_FALL.sunrise, DST_FALL.sunset), false);
    assert.equal(S.isDaylight('2026-11-01T12:00', DST_FALL.sunrise, DST_FALL.sunset), true);
    assert.equal(S.sunEventForHour('2026-11-01T16:00', DST_FALL.sunrise, DST_FALL.sunset), 'sunset');
  });

  it('does not shift wall-clock times when the process TZ changes', () => {
    const script = `
      const S = require(${JSON.stringify(path.resolve(__dirname, '../lib/sun-times.js'))});
      const rise = S.formatSunTime('${DST_SPRING.sunrise}');
      const skip = S.parseOpenMeteoLocal('2026-03-08T02:30');
      const winter = S.formatSunTime('${CHICAGO_WINTER_2024.sunset}');
      if (rise !== '6:12 AM') { console.error('rise', rise); process.exit(1); }
      if (!skip || skip.hour !== 2 || skip.minute !== 30) { console.error(skip); process.exit(2); }
      if (winter !== '4:23 PM') { console.error('winter', winter); process.exit(3); }
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

describe('index daily Open-Meteo sun rows', () => {
  it('keys sunrise/sunset by YYYY-MM-DD', () => {
    const byDate = S.indexDailySun([
      { date: '2024-06-21', sunrise: CHICAGO_SOLSTICE_2024.sunrise, sunset: CHICAGO_SOLSTICE_2024.sunset, wind_dir: 'SW', wind_dir_deg: 225 },
      { time: '2024-06-22', sunrise: 'N/A', sunset: '' }
    ]);
    assert.equal(byDate['2024-06-21'].sunrise, CHICAGO_SOLSTICE_2024.sunrise);
    assert.equal(byDate['2024-06-21'].windDir, 'SW');
    assert.equal(byDate['2024-06-21'].windDirDeg, 225);
    assert.equal(S.sunForDate(byDate, '2024-06-21T14:00').sunset, CHICAGO_SOLSTICE_2024.sunset);
    assert.equal(byDate['2024-06-22'].sunrise, null);
    assert.equal(S.sunForDate(byDate, '2024-06-23'), null);
  });
});

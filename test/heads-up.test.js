'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('path');
const H = require('../lib/heads-up');
const {
  NOW_LOCAL,
  GO_STARTS_SOON,
  GO_STARTS_LATER,
  GO_ENDS_SOON,
  GO_ENDS_THIS_HOUR,
  GO_ALL_AFTERNOON,
  GO_TOMORROW_ONLY,
  NWS_LINCOLN_MIXED,
  NWS_EMPTY
} = require('./fixtures/heads-up');

describe('NWS alert URLs and point parse (no network)', () => {
  it('builds the official point URL and the local proxy URL', () => {
    const url = H.nwsAlertsUrl(40.8136, -96.7026);
    assert.equal(url, 'https://api.weather.gov/alerts/active?point=40.8136,-96.7026');
    assert.equal(
      H.proxyUrl(40.8136, -96.7026),
      '/api/nws-alerts?lat=40.8136&lon=-96.7026'
    );
    assert.match(H.NWS_HEADERS['User-Agent'], /SprayWeatherApp\/2\.0/);
    assert.equal(H.NWS_HEADERS.Accept, 'application/geo+json');
    assert.equal(H.nwsAlertsUrl(91, -96), null);
    assert.equal(H.nwsAlertsUrl(40.8, -181), null);
    assert.equal(H.proxyUrl('nope', -96), null);
  });
});

describe('summarizeAlerts from NWS GeoJSON fixture', () => {
  it('drops empty events, sorts Extreme then Severe then Minor, and caps later', () => {
    const rows = H.summarizeAlerts(NWS_LINCOLN_MIXED);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].event, 'Severe Thunderstorm Warning');
    assert.equal(rows[0].severity, 'Extreme');
    assert.equal(rows[1].event, 'Freeze Watch');
    assert.equal(rows[1].severity, 'Severe');
    assert.equal(rows[2].event, 'Frost Advisory');
    assert.equal(rows[2].severity, 'Minor');
    assert.match(rows[1].headline, /Freeze Watch/);
    assert.equal(H.summarizeAlerts(NWS_EMPTY).length, 0);
    assert.equal(H.summarizeAlerts(null).length, 0);
    assert.equal(H.summarizeAlerts({ features: [{ properties: {} }] }).length, 0);
  });
});

describe('GO soon line at frozen 2026-10-16T13:00 local', () => {
  it('says a GO window starts around 2 PM when the next green hour is soon', () => {
    const note = H.goSoonNote(GO_STARTS_SOON, NOW_LOCAL);
    assert.equal(note, 'A GO spray window starts around 2 PM today.');
    assert.doesNotMatch(note, /favorable|caution|no-good|no-go/i);
  });

  it('stays quiet when the next GO is more than two hours away', () => {
    assert.equal(H.goSoonNote(GO_STARTS_LATER, NOW_LOCAL), null);
  });

  it('says the GO window ends around 2 PM when the last green hour is soon', () => {
    assert.equal(
      H.goSoonNote(GO_ENDS_SOON, NOW_LOCAL),
      'The GO spray window ends around 2 PM today.'
    );
  });

  it('says the GO window ends this hour when 1 PM is the last green block', () => {
    assert.equal(
      H.goSoonNote(GO_ENDS_THIS_HOUR, NOW_LOCAL),
      'The GO spray window ends this hour (1 PM).'
    );
  });

  it('stays quiet when GO continues through the afternoon', () => {
    assert.equal(H.goSoonNote(GO_ALL_AFTERNOON, NOW_LOCAL), null);
  });

  it('ignores tomorrow GO and missing payloads', () => {
    assert.equal(H.goSoonNote(GO_TOMORROW_ONLY, NOW_LOCAL), null);
    assert.equal(H.goSoonNote([], NOW_LOCAL), null);
    assert.equal(H.goSoonNote(GO_STARTS_SOON, 'not-a-time'), null);
    assert.equal(H.goSoonNote(null, NOW_LOCAL), null);
  });

  it('does not treat caution as GO', () => {
    const hours = [
      { time: '2026-10-16T13:00', spray: { status: 'caution', reasons: [] } },
      { time: '2026-10-16T14:00', spray: { status: 'caution', reasons: [] } }
    ];
    assert.equal(H.goSoonNote(hours, NOW_LOCAL), null);
  });
});

describe('naive local now, not Date() / process TZ', () => {
  it('reads now from hourly[0] and from a frozen UTC instant + offset', () => {
    assert.equal(H.nowLocalFromHourly([{ time: NOW_LOCAL }]), NOW_LOCAL);
    assert.equal(H.nowLocalFromHourly(GO_STARTS_SOON), '2026-10-16T12:00');
    const instant = new Date('2026-10-16T18:00:00.000Z');
    assert.equal(
      H.nowLocalFromInstant(instant, { utcOffsetSeconds: -5 * 3600 }),
      NOW_LOCAL
    );
    assert.equal(H.parseNaiveHour('2026-03-08T02:30').hour, 2);
    assert.equal(H.formatClockHour(0), '12 AM');
    assert.equal(H.formatClockHour(13), '1 PM');
  });

  it('does not shift the GO line when the process TZ changes', () => {
    const script = `
      const H = require(${JSON.stringify(path.resolve(__dirname, '../lib/heads-up.js'))});
      const { GO_STARTS_SOON, GO_ENDS_SOON, NOW_LOCAL } = require(${JSON.stringify(path.resolve(__dirname, './fixtures/heads-up.js'))});
      const start = H.goSoonNote(GO_STARTS_SOON, NOW_LOCAL);
      const end = H.goSoonNote(GO_ENDS_SOON, NOW_LOCAL);
      if (start !== 'A GO spray window starts around 2 PM today.') { console.error(start); process.exit(1); }
      if (end !== 'The GO spray window ends around 2 PM today.') { console.error(end); process.exit(2); }
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

describe('buildHeadsUp display-only strip', () => {
  it('is visible with alerts and/or a GO line, and never exports a score', () => {
    const alerts = H.summarizeAlerts(NWS_LINCOLN_MIXED);
    const both = H.buildHeadsUp({ alerts, hourly: GO_STARTS_SOON, nowLocal: NOW_LOCAL });
    assert.equal(both.visible, true);
    assert.equal(both.alerts.length, 3);
    assert.equal(both.alerts[0].event, 'Severe Thunderstorm Warning');
    assert.match(both.goNote, /starts around 2 PM/);

    const quiet = H.buildHeadsUp({
      alerts: [],
      hourly: GO_ALL_AFTERNOON,
      nowLocal: NOW_LOCAL
    });
    assert.equal(quiet.visible, false);
    assert.equal(quiet.goNote, null);

    assert.equal(H.scoreSprayConditions, undefined);
    assert.equal(H.emptyHeadsUp().visible, false);
    assert.doesNotMatch(JSON.stringify(both), /no-go|No-Go/);
  });
});

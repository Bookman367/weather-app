'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('path');
const R = require('../lib/radar-map');
const { CATALOG, CATALOG_WITH_NOWCAST, CATALOG_EMPTY } = require('./fixtures/radar-map');

describe('RainViewer catalog parse and tile URLs (no network)', () => {
  it('uses host + path, color scheme 2, smoothed snow tiles, latest past frame', () => {
    const parsed = R.parseCatalog(CATALOG);
    assert.equal(parsed.host, 'https://tilecache.rainviewer.com');
    assert.equal(parsed.frames.length, 3);
    assert.equal(parsed.latestIndex, 2);
    assert.equal(parsed.frames[2].path, '/v2/radar/frame-c');
    assert.equal(parsed.frames[2].kind, 'past');
    assert.equal(
      R.radarTileUrl(parsed.host, parsed.frames[2]),
      'https://tilecache.rainviewer.com/v2/radar/frame-c/256/{z}/{x}/{y}/2/1_1.png'
    );
    assert.equal(R.COLOR_SCHEME, 2);
    assert.equal(R.TILE_SIZE, 256);
    assert.equal(R.MAX_NATIVE_ZOOM, 7);
    assert.equal(R.RAINVIEWER_API, 'https://api.rainviewer.com/public/weather-maps.json');
  });

  it('appends nowcast after past and keeps latestIndex on the last observed frame', () => {
    const parsed = R.parseCatalog(CATALOG_WITH_NOWCAST);
    assert.equal(parsed.frames.length, 3);
    assert.equal(parsed.latestIndex, 1);
    assert.equal(parsed.frames[2].kind, 'nowcast');
    assert.equal(parsed.host, 'https://tilecache.rainviewer.com');
    assert.deepEqual(R.parseCatalog(CATALOG_EMPTY), { host: '', frames: [], latestIndex: 0 });
    assert.deepEqual(R.parseCatalog(null), { host: '', frames: [], latestIndex: 0 });
    assert.deepEqual(R.parseCatalog({ radar: { past: [{ time: 1 }] } }), {
      host: '', frames: [], latestIndex: 0
    });
  });

  it('exposes Leaflet 1.9.4 assets and satellite/street bases without loading them', () => {
    const assets = R.leafletAssets();
    assert.match(assets.css, /leaflet@1\.9\.4\/dist\/leaflet\.css/);
    assert.match(assets.js, /leaflet@1\.9\.4\/dist\/leaflet\.js/);
    assert.match(R.BASE_LAYERS.street.url, /tile\.openstreetmap\.org/);
    assert.match(R.BASE_LAYERS.satellite.url, /World_Imagery/);
  });
});

describe('frame clock at frozen offset (not process TZ)', () => {
  it('formats 1792119600 as 10:00 PM CDT with utcOffsetSeconds -5h', () => {
    // 1792119600 = 2026-10-16T03:00:00Z → 10:00 PM CDT previous evening.
    assert.equal(
      R.formatFrameClock(1792119600, { utcOffsetSeconds: -5 * 3600 }),
      '10:00 PM'
    );
    assert.equal(
      R.formatFrameClock(1792119600, { utcOffsetSeconds: 0 }),
      '3:00 AM'
    );
    assert.equal(R.formatFrameClock(null, { utcOffsetSeconds: 0 }), '');
  });

  it('does not shift the offset clock when the process TZ changes', () => {
    const script = `
      const R = require(${JSON.stringify(path.resolve(__dirname, '../lib/radar-map.js'))});
      const clock = R.formatFrameClock(1792119600, { utcOffsetSeconds: -5 * 3600 });
      if (clock !== '10:00 PM') { console.error(clock); process.exit(1); }
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

describe('play/pause animator with fake timers', () => {
  it('starts on the latest frame, wraps, and pauses without a network', () => {
    const parsed = R.parseCatalog(CATALOG);
    const seen = [];
    const timers = [];
    let seq = 0;
    function fakeSetTimeout(fn) {
      const id = ++seq;
      timers.push({ id, fn });
      return id;
    }
    function fakeClear(id) {
      const i = timers.findIndex(t => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }
    function flush() {
      const t = timers.shift();
      if (t) t.fn();
    }

    const anim = R.createAnimator(parsed.frames, {
      startIndex: parsed.latestIndex,
      intervalMs: 500,
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClear,
      onFrame(frame, index, playing) {
        seen.push({ path: frame && frame.path, index, playing });
      }
    });

    assert.equal(anim.getIndex(), 2);
    assert.equal(anim.isPlaying(), false);
    assert.equal(seen[0].path, '/v2/radar/frame-c');

    assert.equal(anim.play(), true);
    assert.equal(anim.isPlaying(), true);
    flush();
    assert.equal(anim.getIndex(), 0);
    assert.equal(seen.at(-1).path, '/v2/radar/frame-a');
    flush();
    assert.equal(anim.getIndex(), 1);

    anim.pause();
    assert.equal(anim.isPlaying(), false);
    const afterPause = seen.length;
    flush();
    assert.equal(seen.length, afterPause);
    assert.equal(R.wrapIndex(-1, 3), 2);
    anim.destroy();
  });
});

describe('display only — no spray score', () => {
  it('does not export scoring helpers', () => {
    assert.equal(R.scoreSprayConditions, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(R.parseCatalog(CATALOG), 'status'), false);
  });
});

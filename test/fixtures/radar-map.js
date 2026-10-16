'use strict';

// RainViewer catalog shape (host + radar.past / optional nowcast).
// Times are unix seconds. 1792119600 = 2026-10-16T03:00:00Z.
const CATALOG = {
  version: '2.0',
  generated: 1792119622,
  host: 'https://tilecache.rainviewer.com',
  radar: {
    past: [
      { time: 1792118400, path: '/v2/radar/frame-a' },
      { time: 1792119000, path: '/v2/radar/frame-b' },
      { time: 1792119600, path: '/v2/radar/frame-c' }
    ],
    nowcast: []
  }
};

const CATALOG_WITH_NOWCAST = {
  host: 'https://tilecache.rainviewer.com/',
  radar: {
    past: [
      { time: 1792119000, path: '/v2/radar/frame-b' },
      { time: 1792119600, path: '/v2/radar/frame-c' }
    ],
    nowcast: [
      { time: 1792120200, path: '/v2/radar/frame-d' }
    ]
  }
};

const CATALOG_EMPTY = { host: 'https://tilecache.rainviewer.com', radar: { past: [] } };

module.exports = {
  CATALOG,
  CATALOG_WITH_NOWCAST,
  CATALOG_EMPTY
};

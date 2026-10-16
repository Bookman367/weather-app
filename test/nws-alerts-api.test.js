'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/nws-alerts');
const H = require('../lib/heads-up');
const { NWS_LINCOLN_MIXED } = require('./fixtures/heads-up');

function mockRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    ended: false,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; }
  };
}

describe('/api/nws-alerts proxy (mocked fetch, no network)', () => {
  let prevFetch;

  beforeEach(() => {
    prevFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = prevFetch;
  });

  it('sends the NWS User-Agent and returns summarized alerts', async () => {
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => NWS_LINCOLN_MIXED };
    };
    const res = mockRes();
    await handler({ method: 'GET', query: { lat: '40.8136', lon: '-96.7026' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alerts[0].event, 'Severe Thunderstorm Warning');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, H.nwsAlertsUrl(40.8136, -96.7026));
    assert.equal(calls[0].opts.headers['User-Agent'], H.NWS_USER_AGENT);
    assert.equal(calls[0].opts.headers.Accept, 'application/geo+json');
  });

  it('400s on bad coordinates and fails quietly when NWS is down', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    const bad = mockRes();
    await handler({ method: 'GET', query: { lat: '91', lon: '-96' } }, bad);
    assert.equal(bad.statusCode, 400);

    const down = mockRes();
    await handler({ method: 'GET', query: { lat: '40.8', lon: '-96.7' } }, down);
    assert.equal(down.statusCode, 200);
    assert.equal(down.body.ok, false);
    assert.deepEqual(down.body.alerts, []);

    const options = mockRes();
    await handler({ method: 'OPTIONS', query: {} }, options);
    assert.equal(options.statusCode, 204);
  });
});

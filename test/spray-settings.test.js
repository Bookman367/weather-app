'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreSprayConditions } = require('../lib/spray-logic');
const S = require('../lib/spray-settings');

const IDEAL = {
  temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10,
  delta_t: 4, delta_t_f: 7.2, hour_of_day: 10
};

describe('named spray settings store', () => {
  it('empty / missing storage resolves to the built-in recommended preset', () => {
    const empty = S.loadStore(S.memoryStorage());
    const missing = S.loadStore(null);
    const active = S.resolveActive(empty);
    assert.equal(active.id, S.RECOMMENDED_ID);
    assert.equal(active.name, S.RECOMMENDED_NAME);
    assert.equal(active.builtIn, true);
    assert.equal(S.resolveActive(missing).id, S.RECOMMENDED_ID);
    assert.equal(empty.settings.length, 1);
    assert.equal(empty.scope, 'user');
    assert.equal(empty.jobId, null);
    assert.equal(empty.fieldId, null);
  });

  it('corrupt localStorage falls back to recommended without throwing', () => {
    const storage = S.memoryStorage({ [S.STORAGE_KEY]: '{not-json' });
    const active = S.resolveActive(S.loadStore(storage));
    assert.equal(active.id, S.RECOMMENDED_ID);
  });

  it('creating a named setting persists and becomes active', () => {
    const storage = S.memoryStorage();
    S.upsertSetting(storage, {
      name: 'Herbicide - drift sensitive',
      limits: { max_wind_mph: 8, max_gust_mph: 12, min_rh: 40 }
    });
    const doc = S.loadStore(storage);
    const active = S.resolveActive(doc);
    assert.equal(active.name, 'Herbicide - drift sensitive');
    assert.equal(active.builtIn, false);
    assert.equal(active.limits.max_wind_mph, 8);
    assert.equal(active.limits.min_temp_f, 50);
    assert.equal(doc.settings.length, 2);
  });

  it('recommended cannot be deleted or overwritten', () => {
    const storage = S.memoryStorage();
    assert.throws(() => S.deleteSetting(storage, S.RECOMMENDED_ID));
    assert.throws(() => S.upsertSetting(storage, { id: S.RECOMMENDED_ID, name: 'Nope' }));
  });

  it('deleting the active custom setting falls back to recommended', () => {
    const storage = S.memoryStorage();
    const doc = S.upsertSetting(storage, { name: 'Temp tight', limits: { max_temp_f: 80 } });
    const customId = doc.activeId;
    S.deleteSetting(storage, customId);
    assert.equal(S.resolveActive(S.loadStore(storage)).id, S.RECOMMENDED_ID);
  });

  it('export JSON is Ops-importable (versioned, scoped, job/field slots)', () => {
    const storage = S.memoryStorage();
    S.upsertSetting(storage, { name: 'Herbicide - drift sensitive', limits: { max_wind_mph: 8 } });
    const exported = S.exportDocument(S.loadStore(storage));
    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.app, 'hero');
    assert.equal(exported.kind, 'spray-settings');
    assert.equal(exported.scope, 'user');
    assert.equal(exported.jobId, null);
    assert.equal(exported.fieldId, null);
    assert.ok(exported.exportedAt);
    assert.ok(exported.settings.some(s => s.name === 'Herbicide - drift sensitive'));
    const other = S.memoryStorage();
    S.importDocument(other, exported);
    assert.equal(S.resolveActive(S.loadStore(other)).name, 'Herbicide - drift sensitive');
  });

  it('parseLimitsParam ignores junk and only keeps known scoring keys', () => {
    assert.equal(S.parseLimitsParam(null), null);
    assert.equal(S.parseLimitsParam(''), null);
    assert.equal(S.parseLimitsParam('not-json'), null);
    const parsed = S.parseLimitsParam(JSON.stringify({
      max_wind_mph: 10,
      invented_radar: 99,
      min_rh: '40'
    }));
    assert.equal(parsed.max_wind_mph, 10);
    assert.equal(parsed.min_rh, 40);
    assert.equal(parsed.invented_radar, undefined);
  });
});

describe('custom settings change scoring; recommended does not', () => {
  it('no-setting and recommended produce the same go/caution/no-go as today', () => {
    const baseline = scoreSprayConditions(IDEAL, 'general', 'clarity');
    const recommended = scoreSprayConditions(IDEAL, 'general', 'clarity', S.recommendedLimits());
    assert.deepEqual(recommended, Object.assign({}, baseline, {
      product: recommended.product
    }));
    assert.equal(baseline.status, 'favorable');
    assert.deepEqual(baseline.reasons, []);
  });

  it('a drift-sensitive setting turns otherwise-OK wind into no-go', () => {
    const hour = Object.assign({}, IDEAL, { wind_mph: 12 });
    const today = scoreSprayConditions(hour, 'general', 'clarity');
    assert.equal(today.status, 'favorable');

    const custom = S.parseLimitsParam({ max_wind_mph: 8, max_gust_mph: 12 });
    const scored = scoreSprayConditions(hour, 'general', 'clarity', custom);
    assert.equal(scored.status, 'no-good');
    assert.ok(scored.reasons.some(r => /Wind 12 mph exceeds limit \(8 mph\)/.test(r)));
  });
});

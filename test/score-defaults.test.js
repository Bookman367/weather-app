'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PRODUCTS,
  scoreSprayConditions,
  scoreHourly,
  mapHeroStatus
} = require('../lib/spray-logic');
const {
  RECOMMENDED_LIMITS,
  recommendedLimits,
  pickLimits
} = require('../lib/spray-settings');

const HOURS = {
  ideal: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10, cloud_pct: 40 },
  windHigh: { temp_f: 72, wind_mph: 16, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  windApproach: { temp_f: 72, wind_mph: 13, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  gustHigh: { temp_f: 72, wind_mph: 8, gust_mph: 21, rh: 50, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  tempLow: { temp_f: 40, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  tempHigh: { temp_f: 96, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  rhLow: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 20, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  rhHigh: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 96, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  precipHigh: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 40, delta_t: 4, delta_t_f: 7.2, hour_of_day: 10 },
  inversion: { temp_f: 72, wind_mph: 3, gust_mph: 4, rh: 50, precip_pct: 10, delta_t: 1, delta_t_f: 1.8, hour_of_day: 10 },
  nightGood: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 4, delta_t_f: 7.2, hour_of_day: 2 },
  nightCaution: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 8, delta_t_f: 14.4, hour_of_day: 2 },
  dayRed: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 11, delta_t_f: 19.8, hour_of_day: 10 },
  dayEdge: { temp_f: 70, wind_mph: 8, gust_mph: 10, rh: 30, precip_pct: 10, delta_t: 10, delta_t_f: 18, hour_of_day: 10 },
  uniLow: { temp_f: 72, wind_mph: 8, gust_mph: 10, rh: 50, precip_pct: 10, delta_t: 0.5, delta_t_f: 0.9, hour_of_day: 10 }
};

// Locked from current live scoring BEFORE optional limits were added.
const EXPECTED = [
  { name: 'ideal', product: 'general', method: 'clarity', status: 'favorable', reasons: [], productName: 'General (Ag Guidelines)' },
  { name: 'ideal', product: 'general', method: 'university', status: 'favorable', reasons: [], productName: 'General (Ag Guidelines)' },
  { name: 'ideal', product: 'Dicamba', method: 'clarity', status: 'favorable', reasons: [], productName: 'Dicamba (Clarity/Banvel)' },
  { name: 'windHigh', product: 'general', method: 'clarity', status: 'no-good', reasons: ['Wind 16 mph exceeds limit (15 mph)'], productName: 'General (Ag Guidelines)' },
  { name: 'windHigh', product: 'Dicamba', method: 'clarity', status: 'no-good', reasons: ['Wind 16 mph exceeds limit (10 mph)'], productName: 'Dicamba (Clarity/Banvel)' },
  { name: 'windApproach', product: 'general', method: 'clarity', status: 'caution', reasons: ['Wind 13 mph approaching limit (15 mph)'], productName: 'General (Ag Guidelines)' },
  { name: 'windApproach', product: 'Dicamba', method: 'clarity', status: 'no-good', reasons: ['Wind 13 mph exceeds limit (10 mph)'], productName: 'Dicamba (Clarity/Banvel)' },
  { name: 'gustHigh', product: 'general', method: 'clarity', status: 'no-good', reasons: ['Gusts 21 mph exceed limit (20 mph)'], productName: 'General (Ag Guidelines)' },
  { name: 'tempLow', product: 'general', method: 'clarity', status: 'no-good', reasons: ['Temp IS 40°F — below minimum 50°F'], productName: 'General (Ag Guidelines)' },
  { name: 'tempHigh', product: 'general', method: 'clarity', status: 'no-good', reasons: ['Temp IS 96°F — above maximum 95°F'], productName: 'General (Ag Guidelines)' },
  { name: 'tempHigh', product: 'Detonate + 2,4-D', method: 'clarity', status: 'caution', reasons: ['High volatility risk: temp 96°F > preferred max 86°F'], productName: 'Detonate + 2,4-D (Pasture near Soybeans)' },
  { name: 'rhLow', product: 'general', method: 'clarity', status: 'no-good', reasons: ['RH 20% too low — drift risk (< 30%)'], productName: 'General (Ag Guidelines)' },
  { name: 'rhHigh', product: 'general', method: 'clarity', status: 'caution', reasons: ['RH 96% too high (> 95%)'], productName: 'General (Ag Guidelines)' },
  { name: 'precipHigh', product: 'general', method: 'clarity', status: 'no-good', reasons: ['Precipitation 40% exceeds threshold (30%)'], productName: 'General (Ag Guidelines)' },
  { name: 'inversion', product: 'general', method: 'clarity', status: 'caution', reasons: ['Clarity Delta-T 1.8°F <5°F', 'Inversion conditions possible — Delta-T low with light winds'], productName: 'General (Ag Guidelines)' },
  { name: 'inversion', product: 'Roundup (Glyphosate)', method: 'clarity', status: 'caution', reasons: ['Clarity Delta-T 1.8°F <5°F'], productName: 'Roundup / Glyphosate' },
  { name: 'nightGood', product: 'general', method: 'clarity', status: 'favorable', reasons: [], productName: 'General (Ag Guidelines)' },
  { name: 'nightCaution', product: 'general', method: 'clarity', status: 'caution', reasons: ['Clarity Delta-T 14.4°F night 12–18°F — elevated'], productName: 'General (Ag Guidelines)' },
  { name: 'nightCaution', product: 'general', method: 'university', status: 'favorable', reasons: [], productName: 'General (Ag Guidelines)' },
  { name: 'dayRed', product: 'general', method: 'clarity', status: 'no-good', reasons: ['Clarity Delta-T 19.8°F ≥19°F — evaporation risk'], productName: 'General (Ag Guidelines)' },
  { name: 'dayRed', product: 'general', method: 'university', status: 'caution', reasons: ['University Delta-T 19.8°F elevated (> 15°F)'], productName: 'General (Ag Guidelines)' },
  { name: 'dayEdge', product: 'general', method: 'clarity', status: 'favorable', reasons: ['Clarity Delta-T 18°F — warm/dry edge, monitor'], productName: 'General (Ag Guidelines)' },
  { name: 'uniLow', product: 'general', method: 'university', status: 'caution', reasons: ['University Delta-T 0.9°F too low (< 2°F)'], productName: 'General (Ag Guidelines)' }
];

describe('default scoring is unchanged when no custom setting is chosen', () => {
  it('recommended limits match PRODUCTS.general (same shape the scorer already uses)', () => {
    const fromProduct = pickLimits(PRODUCTS.general);
    assert.deepEqual(RECOMMENDED_LIMITS, fromProduct);
    assert.deepEqual(recommendedLimits(), fromProduct);
  });

  for (const row of EXPECTED) {
    it(`${row.name} / ${row.product} / ${row.method} stays ${row.status}`, () => {
      const hour = HOURS[row.name];
      const threeArg = scoreSprayConditions(hour, row.product, row.method);
      const omittedLimits = scoreSprayConditions(hour, row.product, row.method, undefined);
      const twoArg = row.method === 'clarity' ? scoreSprayConditions(hour, row.product) : threeArg;

      assert.equal(threeArg.status, row.status);
      assert.deepEqual(threeArg.reasons, row.reasons);
      assert.equal(threeArg.product, row.productName);
      assert.deepEqual(omittedLimits, threeArg);
      assert.deepEqual(twoArg, threeArg);
    });
  }

  it('Recommended limits overlay on general matches the no-setting path', () => {
    for (const [name, hour] of Object.entries(HOURS)) {
      const baseline = scoreSprayConditions(hour, 'general', 'clarity');
      const withRecommended = scoreSprayConditions(hour, 'general', 'clarity', recommendedLimits());
      assert.deepEqual(
        { status: withRecommended.status, reasons: withRecommended.reasons },
        { status: baseline.status, reasons: baseline.reasons },
        name
      );
    }
  });

  it('scoreHourly defaults (general + clarity) match per-hour scoreSprayConditions', () => {
    const hourly = Object.values(HOURS).map(h => Object.assign({}, h));
    const scored = scoreHourly(hourly.map(h => Object.assign({}, h)));
    hourly.forEach((h, i) => {
      assert.deepEqual(scored[i].spray, scoreSprayConditions(h, 'general', 'clarity'));
    });
  });

  it('mapHeroStatus go/caution/no-go labels are unchanged', () => {
    assert.equal(mapHeroStatus('favorable'), 'go');
    assert.equal(mapHeroStatus('caution'), 'caution');
    assert.equal(mapHeroStatus('no-good'), 'no-go');
    assert.equal(mapHeroStatus('unknown'), 'no-go');
  });
});

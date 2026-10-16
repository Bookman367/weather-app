'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../lib/wind-display');
const { PRODUCTS, scoreSprayConditions, degToCardinal } = require('../lib/spray-logic');

const GENERAL = {
  max_wind_mph: PRODUCTS.general.max_wind_mph,
  max_gust_mph: PRODUCTS.general.max_gust_mph
};
const DICAMBA = {
  max_wind_mph: PRODUCTS.Dicamba.max_wind_mph,
  max_gust_mph: PRODUCTS.Dicamba.max_gust_mph
};

function scoreWindOnly(wind, gust, product) {
  return scoreSprayConditions({
    temp_f: 72, wind_mph: wind, gust_mph: gust, rh: 50, precip_pct: 10,
    delta_t: 4, delta_t_f: 7.2, hour_of_day: 10, cloud_pct: 40
  }, product, 'clarity');
}

describe('compass from meteorological degrees', () => {
  it('matches known 16-point bearings and spray-logic degToCardinal', () => {
    const known = [
      [0, 'N'], [11.2, 'N'], [22.5, 'NNE'], [45, 'NE'], [90, 'E'],
      [180, 'S'], [270, 'W'], [315, 'NW'], [337.5, 'NNW'], [360, 'N']
    ];
    for (const [deg, compass] of known) {
      assert.equal(W.degToCompass(deg), compass, `${deg}°`);
      assert.equal(W.degToCompass(deg), degToCardinal(deg), `parity at ${deg}°`);
    }
    assert.equal(W.degToCompass(null), 'N/A');
    assert.equal(W.degToCompass('NW'), 'NW');
    assert.equal(W.arrowDeg(-45), 315);
    assert.equal(W.arrowDeg(405), 45);
  });
});

describe('drift note uses existing spray wind / gust limits only', () => {
  it('general 15 / 20 mph: within, approaching (80%), over wind, over gust', () => {
    assert.equal(GENERAL.max_wind_mph, 15);
    assert.equal(GENERAL.max_gust_mph, 20);

    const within = W.driftRiskFromLimits(8, 10, GENERAL);
    assert.equal(within.band, 'within');
    assert.match(within.note, /within the spray wind limits \(15 \/ 20 mph\)/);

    // scoreSprayConditions: wind > max * 0.8 → caution. 12 == 12 is not >.
    const atEighty = W.driftRiskFromLimits(12, 10, GENERAL);
    assert.equal(atEighty.band, 'within');
    const approaching = W.driftRiskFromLimits(13, 10, GENERAL);
    assert.equal(approaching.band, 'approaching');
    assert.match(approaching.note, /approaching the spray limit \(15 mph\)/);

    const overWind = W.driftRiskFromLimits(16, 10, GENERAL);
    assert.equal(overWind.band, 'over-limit');
    assert.match(overWind.note, /over the spray limit \(15 \/ 20 mph\)/);

    const overGust = W.driftRiskFromLimits(8, 21, GENERAL);
    assert.equal(overGust.band, 'over-limit');
  });

  it('Dicamba 10 / 15 mph uses that product\'s caps, not a second scale', () => {
    assert.equal(DICAMBA.max_wind_mph, 10);
    const ok = W.driftRiskFromLimits(8, 10, DICAMBA);
    assert.equal(ok.band, 'within');
    const watch = W.driftRiskFromLimits(9, 10, DICAMBA);
    assert.equal(watch.band, 'approaching');
    const over = W.driftRiskFromLimits(11, 10, DICAMBA);
    assert.equal(over.band, 'over-limit');
    assert.match(over.note, /10 \/ 15 mph/);
  });

  it('zero-gust setting flags any gust, matching scoreSprayConditions', () => {
    const note = W.driftRiskFromLimits(8, 3, { max_wind_mph: 15, max_gust_mph: 0 });
    assert.equal(note.band, 'over-limit');
    assert.match(note.note, /no gusts/);
  });

  it('does not invent go/caution/no-go and stays aligned with the scorer', () => {
    const cases = [
      { wind: 8, gust: 10, product: 'general' },
      { wind: 13, gust: 10, product: 'general' },
      { wind: 16, gust: 10, product: 'general' },
      { wind: 8, gust: 21, product: 'general' },
      { wind: 9, gust: 10, product: 'Dicamba' },
      { wind: 11, gust: 10, product: 'Dicamba' }
    ];
    for (const row of cases) {
      const scored = scoreWindOnly(row.wind, row.gust, row.product);
      const p = PRODUCTS[row.product];
      const drift = W.driftRiskFromLimits(row.wind, row.gust, p);
      const windOver = row.wind > p.max_wind_mph || row.gust > p.max_gust_mph;
      const windWatch = row.wind > p.max_wind_mph * 0.8 && !windOver;
      if (windOver) {
        assert.equal(drift.band, 'over-limit');
        assert.equal(scored.status, 'no-good');
      } else if (windWatch) {
        assert.equal(drift.band, 'approaching');
        assert.ok(scored.reasons.some(r => /approaching limit/.test(r)));
      } else {
        assert.equal(drift.band, 'within');
      }
      assert.equal(Object.prototype.hasOwnProperty.call(drift, 'status'), false);
      assert.doesNotMatch(drift.note, /go\/caution|no-go|No-Go|favorable/i);
    }
  });

  it('describeWind packs arrow, compass, and note without changing numbers', () => {
    const shown = W.describeWind(8, 12, 315, GENERAL);
    assert.equal(shown.wind, 8);
    assert.equal(shown.gust, 12);
    assert.equal(shown.windDir, 'NW');
    assert.equal(shown.arrowDeg, 315);
    assert.equal(shown.driftBand, 'within');
    assert.equal(W.driftRiskFromLimits(null, null, GENERAL).band, 'unknown');
    assert.equal(W.driftRiskFromLimits(8, 10, null).band, 'unknown');
  });
});

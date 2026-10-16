// ============================================================
// Wind / drift display — reuse existing spray wind limits
//
// Compass and a plain-language drift note for the spray map.
// Thresholds are the same ones scoreSprayConditions already uses:
//   wind > max_wind_mph            → over the spray wind limit
//   wind > max_wind_mph * 0.8      → approaching the spray wind limit
//   gust > max_gust_mph            → over the spray gust limit
//   max_gust_mph === 0 && gust > 0 → zero-gust product, any gust is over
//
// Display only. Does not return go / caution / no-go and must not be
// fed back into scoring. "Blowing toward a sensitive side" is out of
// scope — direction is shown as an arrow + compass text only.
//
// Works in Node (require) and the browser (global WindDisplay).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.WindDisplay = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Same 16-point rose as degToCardinal in lib/spray-logic.js.
  const COMPASS_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function degToCompass(deg) {
    if (deg === null || deg === undefined || deg === '') return 'N/A';
    if (typeof deg === 'string') {
      const trimmed = deg.trim();
      if (!trimmed) return 'N/A';
      if (Number.isNaN(Number(trimmed))) return trimmed.toUpperCase();
      deg = Number(trimmed);
    }
    const n = finiteNumber(deg);
    if (n == null) return 'N/A';
    return COMPASS_16[Math.round(n / 22.5) % 16];
  }

  function arrowDeg(deg) {
    const n = finiteNumber(deg);
    if (n == null) return null;
    return ((n % 360) + 360) % 360;
  }

  function resolveWindLimits(limits) {
    if (!limits || typeof limits !== 'object') return null;
    const maxWind = finiteNumber(limits.max_wind_mph);
    const maxGust = finiteNumber(limits.max_gust_mph);
    if (maxWind == null || maxGust == null) return null;
    return { max_wind_mph: maxWind, max_gust_mph: maxGust };
  }

  // Same comparisons as scoreSprayConditions wind / gust blocks.
  function driftRiskFromLimits(windMph, gustMph, limits) {
    const wind = finiteNumber(windMph);
    const gust = finiteNumber(gustMph);
    const caps = resolveWindLimits(limits);
    if (wind == null && gust == null) {
      return { band: 'unknown', note: 'Wind data unavailable' };
    }
    if (!caps) {
      return { band: 'unknown', note: 'Spray wind limits unavailable' };
    }

    const usedWind = wind == null ? 0 : wind;
    const usedGust = gust == null ? 0 : gust;
    const approaching = caps.max_wind_mph * 0.8;
    const limitText = `${caps.max_wind_mph} / ${caps.max_gust_mph} mph`;

    if (caps.max_gust_mph === 0 && usedGust > 0) {
      return {
        band: 'over-limit',
        note: `High drift risk — this setting allows no gusts (${usedGust} mph gust)`
      };
    }
    if (usedWind > caps.max_wind_mph || usedGust > caps.max_gust_mph) {
      return {
        band: 'over-limit',
        note: `High drift risk — wind or gusts over the spray limit (${limitText})`
      };
    }
    if (usedWind > approaching) {
      return {
        band: 'approaching',
        note: `Watch drift — wind approaching the spray limit (${caps.max_wind_mph} mph)`
      };
    }
    return {
      band: 'within',
      note: `Drift risk within the spray wind limits (${limitText})`
    };
  }

  function describeWind(windMph, gustMph, deg, limits) {
    const drift = driftRiskFromLimits(windMph, gustMph, limits);
    return {
      wind: finiteNumber(windMph),
      gust: finiteNumber(gustMph),
      windDirDeg: finiteNumber(deg),
      windDir: degToCompass(deg),
      arrowDeg: arrowDeg(deg),
      driftBand: drift.band,
      driftNote: drift.note
    };
  }

  return {
    COMPASS_16,
    degToCompass,
    arrowDeg,
    resolveWindLimits,
    driftRiskFromLimits,
    describeWind
  };
}));

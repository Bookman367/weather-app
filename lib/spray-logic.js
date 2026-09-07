// ============================================================
// Shared Hero spray logic — single scoring engine
// Used by /api/forecast (UI) and /api/spray-window (Ops).
// Do not duplicate these rules in DroneSense Ops or elsewhere.
//
// Bump LOGIC_VERSION whenever PRODUCTS or scoreSprayConditions change.
// ============================================================

const LOGIC_VERSION = '2026.09.07';

// ── Product Label Thresholds ─────────────────────────────────
const PRODUCTS = {
  general: {
    name: "General (Ag Guidelines)",
    max_wind_mph: 15, max_gust_mph: 20,
    min_temp_f: 50,   max_temp_f: 95,
    min_rh: 30,       max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,   max_delta_t: 8,
    avoid_inversion: true,
    notes: "Standard USDA/Extension ag spray guidelines"
  },
  "2,4-D Amine": {
    name: "2,4-D Amine",
    max_wind_mph: 15, max_gust_mph: 20,
    min_temp_f: 60,   max_temp_f: 85,
    min_rh: 40,       max_rh: 90,
    max_precip_pct: 25,
    min_delta_t: 2,   max_delta_t: 8,
    avoid_inversion: true,
    notes: "Common broadleaf killer; temp-sensitive volatility above 85°F"
  },
  "Dicamba": {
    name: "Dicamba (Clarity/Banvel)",
    max_wind_mph: 10, max_gust_mph: 15,
    min_temp_f: 65,   max_temp_f: 85,
    min_rh: 40,       max_rh: 90,
    max_precip_pct: 20,
    min_delta_t: 2,   max_delta_t: 7,
    avoid_inversion: true,
    notes: "Highly volatile; strict wind & temp limits; avoid near sensitive crops"
  },
  "GrazonNext HL": {
    name: "GrazonNext HL",
    max_wind_mph: 10, max_gust_mph: 15,
    min_temp_f: 55,   max_temp_f: 90,
    min_rh: 40,       max_rh: 85,
    max_precip_pct: 20,
    min_delta_t: 2,   max_delta_t: 8,
    avoid_inversion: true,
    notes: "Avoid drift; temps >90°F increase volatility (EPA label)"
  },
  "Grazon P+D": {
    name: "Grazon P+D",
    max_wind_mph: 12, max_gust_mph: 18,
    min_temp_f: 60,   max_temp_f: 90,
    min_rh: 35,       max_rh: 90,
    max_precip_pct: 25,
    min_delta_t: 2,   max_delta_t: 8,
    avoid_inversion: true,
    notes: "Picloram + 2,4-D combination; moderate wind sensitivity"
  },
  "Roundup (Glyphosate)": {
    name: "Roundup / Glyphosate",
    max_wind_mph: 15, max_gust_mph: 20,
    min_temp_f: 50,   max_temp_f: 95,
    min_rh: 30,       max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,   max_delta_t: 10,
    avoid_inversion: false,
    notes: "Most forgiving; avoid rain within 4h of application"
  },
  "Tordon 22K": {
    name: "Tordon 22K (Picloram)",
    max_wind_mph: 10, max_gust_mph: 15,
    min_temp_f: 55,   max_temp_f: 90,
    min_rh: 40,       max_rh: 90,
    max_precip_pct: 20,
    min_delta_t: 2,   max_delta_t: 8,
    avoid_inversion: true,
    notes: "Highly persistent; strict drift management required"
  },
  "Remedy Ultra": {
    name: "Remedy Ultra (Triclopyr)",
    max_wind_mph: 12, max_gust_mph: 18,
    min_temp_f: 60,   max_temp_f: 90,
    min_rh: 35,       max_rh: 90,
    max_precip_pct: 25,
    min_delta_t: 2,   max_delta_t: 8,
    avoid_inversion: true,
    notes: "Brush/woody plant control; avoid high temp volatility"
  },
  "Detonate + 2,4-D": {
    name: "Detonate + 2,4-D (Pasture near Soybeans)",
    max_wind_mph: 15, max_gust_mph: 15,  // Gusts allowed up to 15 mph
    min_temp_f: 50,   max_temp_f: 999,  // 999 = no hard max, prefer <86°F
    min_rh: 30,       max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,   max_delta_t: 8,
    avoid_inversion: true,
    prefer_max_temp_f: 86,             // Preferred max, not hard limit
    hours_after_rain: 4,              // No rain/irrigation for 4 hours after
    // Inversion rules: wind <4 mph = high risk; cloud cover ≤25% overnight = high risk
    inversion_wind_threshold: 4,
    inversion_cloud_threshold: 25,
    // Spray timing: 2h after sunrise to 2h before sunset preferred
    timing_prefer_sunrise_offset: 2,
    timing_prefer_sunset_offset: -2,
    // Extended window: sunset to 2h after sunrise ONLY if wind 5-15 mph steady
    timing_extended_min_wind: 5,
    timing_extended_max_wind: 15,
    notes: "Ultra-safe criteria for Detonate+2,4-D near soybeans. No gusts. Prefer temps <86°F. Inversion risk: wind <4 mph or cloud cover ≤25% overnight."
  }
};

// ── Spray Condition Scoring ──────────────────────────────────
// ── Scoring Logic: Clarity vs University ─────────────────────
/**
 * Scores spray suitability based on weather data and product label requirements.
 * 
 * @param {Object} hour - Hourly weather object including delta_t, wind, etc.
 * @param {string} product - String key for the chemical product.
 * @param {string} method - Scoring methodology ('clarity' or 'university').
 * @returns {Object} { status, reasons, product }
 */
function scoreSprayConditions(hour, product, method = 'clarity') {
  const p = PRODUCTS[product] || PRODUCTS.general;
  const deltaT = hour.delta_t; // °C spread
  const deltaTF = deltaT * 9 / 5; // °F spread

  let status = 'favorable';
  const reasons = [];

  // ── Delta-T check (method-dependent) ──────────────────
  if (method === 'clarity') {
    // Clarity v2 exact bands (2026-05):
    //
    // GREEN:
    //   Night  (00:00–04:59): Delta-T 5–11°F
    //   Day/Ev (05:00–23:59): Delta-T 5–17°F
    //   Day edge            : Delta-T 18°F only if RH <40% AND air >65°F
    //
    // CAUTION:
    //   Delta-T <5°F  — any hour, any window
    //   Night (00–04): Delta-T 12–18°F
    //   Day (05–23)  : Delta-T 18°F failing edge conditions (not RH<40 / air>65)
    //
    // RED:
    //   Delta-T ≥19°F — any hour, any window
    //
    // Product thresholds (wind/gusts/precip/temp/inversion) apply independently.
    // Stull wet-bulb formula unchanged. No RH modifier inside green bands.
    const hourOfDay = hour.hour_of_day; // 0–23

    if (hourOfDay !== undefined) {
      const isNight = hourOfDay < 5; // 0–4 = night

      if (isNight) {
        // Night 00:00–04:59
        if (deltaTF >= 5 && deltaTF <= 11) {
          status = 'favorable';
        } else if (deltaTF < 5) {
          status = 'caution';
          reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F <5°F night`);
        } else if (deltaTF >= 19) {
          status = 'no-good';
          reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F ≥19°F — evaporation risk`);
        } else {
          // 12–18°F night: above the 11°F ceiling
          status = 'caution';
          reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F night 12–18°F — elevated`);
        }
      } else {
        // Day/Evening 05:00–23:59
        if (deltaTF >= 5 && deltaTF <= 17) {
          // Green band: 5–17°F daytime/evening
          status = 'favorable';
        } else if (deltaTF < 5) {
          status = 'caution';
          reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F <5°F`);
        } else if (deltaTF === 18 && hour.rh < 40 && hour.temp_f > 65) {
          // 18°F edge: green only when dry + warm, else caution
          status = 'favorable';
          reasons.push(`Clarity Delta-T 18°F — warm/dry edge, monitor`);
        } else if (deltaTF >= 19) {
          status = 'no-good';
          reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F ≥19°F — evaporation risk`);
        } else {
          // 18°F failing edge conditions (RH ≥40% or air ≤65°F) → caution
          status = 'caution';
          reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F — 18°F marginal`);
        }
      }
    } else {
      // Fallback: no hour_of_day — use 5–17°F simple range
      if (deltaTF >= 5 && deltaTF <= 17) {
        status = 'favorable';
      } else if (deltaTF < 5) {
        status = 'caution';
        reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F <5°F`);
      } else if (deltaTF >= 19) {
        status = 'no-good';
        reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F ≥19°F — evaporation risk`);
      } else {
        status = 'caution';
        reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F — marginal`);
      }
    }
  } else {
    // University: Delta-T 2-15°F is caution range
    if (deltaTF < 2) {
      status = 'caution';
      reasons.push(`University Delta-T ${deltaTF.toFixed(1)}°F too low (< 2°F)`);
    } else if (deltaTF > 15) {
      status = status === 'no-good' ? 'no-good' : 'caution';
      reasons.push(`University Delta-T ${deltaTF.toFixed(1)}°F elevated (> 15°F)`);
    }
  }

  // ── Product threshold checks ────────────────────────────
  const tempF = hour.temp_f;
  if (tempF < p.min_temp_f) {
    status = 'no-good';
    reasons.push(`Temp IS ${tempF.toFixed(0)}°F — below minimum ${p.min_temp_f}°F`);
  } else if (tempF > p.max_temp_f) {
    status = 'no-good';
    reasons.push(`Temp IS ${tempF.toFixed(0)}°F — above maximum ${p.max_temp_f}°F`);
  }

  const windMph = hour.wind_mph;
  if (windMph > p.max_wind_mph) {
    status = 'no-good';
    reasons.push(`Wind ${windMph.toFixed(0)} mph exceeds limit (${p.max_wind_mph} mph)`);
  } else if (windMph > p.max_wind_mph * 0.8 && status !== 'no-good') {
    status = status === 'caution' ? 'caution' : 'caution';
    reasons.push(`Wind ${windMph.toFixed(0)} mph approaching limit (${p.max_wind_mph} mph)`);
  }

  const gustMph = hour.gust_mph;
  if (gustMph > p.max_gust_mph) {
    status = 'no-good';
    reasons.push(`Gusts ${gustMph.toFixed(0)} mph exceed limit (${p.max_gust_mph} mph)`);
  }

  const rh = hour.rh;
  if (rh < p.min_rh) {
    status = 'no-good';
    reasons.push(`RH ${rh}% too low — drift risk (< ${p.min_rh}%)`);
  } else if (rh > p.max_rh) {
    status = status === 'no-good' ? 'no-good' : 'caution';
    reasons.push(`RH ${rh}% too high (> ${p.max_rh}%)`);
  }

  const precipPct = hour.precip_pct || 0;
  if (precipPct > p.max_precip_pct) {
    status = 'no-good';
    reasons.push(`Precipitation ${precipPct}% exceeds threshold (${p.max_precip_pct}%)`);
  }

  // ── Inversion check ────────────────────────────────────
  if (p.avoid_inversion && deltaT < 2 && windMph < 5) {
    if (status !== 'no-good') status = 'caution';
    reasons.push('Inversion conditions possible — Delta-T low with light winds');
  }

  // ── Detonate + 2,4-D Enhanced Inversion Check ─────────────────
  // Enhanced inversion detection: wind <4 mph OR cloud cover ≤25% overnight
  if (p.inversion_wind_threshold && p.inversion_cloud_threshold) {
    const invWindThresh = p.inversion_wind_threshold;
    const invCloudThresh = p.inversion_cloud_threshold;
    const isLowWind = windMph < invWindThresh;
    const isClearSky = hour.cloud_pct !== undefined && hour.cloud_pct <= invCloudThresh;
    if (isLowWind || isClearSky) {
      if (status !== 'no-good') status = 'caution';
      if (isLowWind) reasons.push(`Inversion risk: wind ${windMph.toFixed(0)} mph <${invWindThresh} mph threshold`);
      if (isClearSky) reasons.push(`Inversion risk: cloud cover ${hour.cloud_pct}% ≤${invCloudThresh}% (clear sky)`);
    }
  }

  // ── Detonate + 2,4-D Gust Check ──────────────────────────────
  // max_gust_mph: 0 means NO gusts allowed (hard limit for Detonate+2,4-D)
  if (p.max_gust_mph === 0 && gustMph > 0) {
    status = 'no-good';
    reasons.push(`Gusts ${gustMph.toFixed(0)} mph NOT permitted for ${p.name} — zero tolerance`);
  }

  // ── Detonate + 2,4-D Preferred Temp Check ─────────────────────
  // prefer_max_temp_f is a soft limit (warning, not hard stop)
  if (p.prefer_max_temp_f && tempF > p.prefer_max_temp_f) {
    if (status !== 'no-good') status = 'caution';
    reasons.push(`High volatility risk: temp ${tempF.toFixed(0)}°F > preferred max ${p.prefer_max_temp_f}°F`);
  }

  return { status, reasons, product: p.name };
}

// ── Delta-T: °C (ag standard) and °F equivalent ─────────────
// Delta-T = dry bulb - wet bulb (always in °C by ag convention)
// Optimal spraying: 2–8°C. <2 = inversion risk, >8 = evaporation
function calcDeltaT(tempC, rh) {
  // Stull wet-bulb approximation
  const wetBulb = tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
    + Math.atan(tempC + rh)
    - Math.atan(rh - 1.676331)
    + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh)
    - 4.686035;
  return Math.max(0, tempC - wetBulb);
}
// Convert Delta-T °C spread to °F spread (multiply by 9/5 — no offset, it's a difference)
function deltaTtoF(dtC) { return dtC * 9 / 5; }

// ── Feels-Like Temperature (°F) ──────────────────────────────
// Wind chill below 50°F, heat index above 80°F, else actual temp
function calcFeelsLike(tempF, rh, windMph) {
  if (tempF <= 50 && windMph >= 3) {
    // NWS Wind Chill formula
    return 35.74 + 0.6215*tempF - 35.75*Math.pow(windMph,0.16) + 0.4275*tempF*Math.pow(windMph,0.16);
  } else if (tempF >= 80) {
    // Rothfusz Heat Index
    const hi = -42.379 + 2.04901523*tempF + 10.14333127*rh
      - 0.22475541*tempF*rh - 0.00683783*tempF*tempF
      - 0.05481717*rh*rh + 0.00122874*tempF*tempF*rh
      + 0.00085282*tempF*rh*rh - 0.00000199*tempF*tempF*rh*rh;
    return hi;
  }
  return tempF;
}

// ── Sunrise/Sunset (Astronomical, no API needed) ─────────────
// Returns { sunrise: "6:42 AM", sunset: "7:58 PM" } local time
function calcSunriseSunset(lat, lon, dateStr, tzOffsetSeconds) {
  const date = new Date(dateStr + 'T12:00:00Z');
  const JD = date.getTime() / 86400000 + 2440587.5;
  const n  = Math.round(JD - 2451545.0 + 0.0008);
  const Js = n - lon / 360;
  const M  = (357.5291 + 0.98560028 * Js) % 360;
  const Mr = M * Math.PI / 180;
  const C  = 1.9148*Math.sin(Mr) + 0.02*Math.sin(2*Mr) + 0.0003*Math.sin(3*Mr);
  const lam = (M + C + 180 + 102.9372) % 360;
  const Jtr = 2451545.0 + Js + 0.0053*Math.sin(Mr) - 0.0069*Math.sin(2*lam*Math.PI/180);
  const sinD = Math.sin(lam * Math.PI/180) * Math.sin(23.4397 * Math.PI/180);
  const cosH = (Math.sin(-0.833*Math.PI/180) - Math.sin(lat*Math.PI/180)*sinD)
             / (Math.cos(lat*Math.PI/180) * Math.cos(Math.asin(sinD)));
  if (Math.abs(cosH) > 1) return { sunrise: 'N/A', sunset: 'N/A' }; // polar day/night
  const H  = Math.acos(cosH) * 180 / Math.PI;
  const Jrise = Jtr - H / 360;
  const Jset  = Jtr + H / 360;

  function jdToLocal(jd) {
    const ms = (jd - 2440587.5) * 86400000 + tzOffsetSeconds * 1000;
    const d  = new Date(ms);
    let h = d.getUTCHours(), m = d.getUTCMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2,'0')} ${ampm}`;
  }

  return { sunrise: jdToLocal(Jrise), sunset: jdToLocal(Jset) };
}

// ── Hours Until Next Rain ────────────────────────────────────
function hoursUntilRain(hourly, rainThresholdPct = 30) {
  for (let i = 0; i < hourly.length; i++) {
    if ((hourly[i].precip_pct || 0) >= rainThresholdPct) return i;
  }
  return null; // no rain in forecast window
}

// ── Wind direction degrees → cardinal + bearing arrow ────────
function degToCardinal(deg) {
  if (deg === null || deg === undefined) return 'N/A';
  if (typeof deg === 'string') return deg; // already a cardinal like "SSW"
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── Cardinal string (NWS) → degrees ──────────────────────────
function cardinalToDeg(cardinal) {
  if (cardinal === null || cardinal === undefined) return null;
  if (typeof cardinal === 'number') return cardinal; // already degrees
  const map = {
    'N':0,'NNE':22,'NE':45,'ENE':67,'E':90,'ESE':112,'SE':135,'SSE':157,
    'S':180,'SSW':202,'SW':225,'WSW':247,'W':270,'WNW':292,'NW':315,'NNW':337
  };
  return map[cardinal.toUpperCase()] ?? null;
}

// ── WMO weather code → description + emoji ───────────────────
function wmoToCondition(code) {
  if (code === 0)  return { desc: 'Clear',        icon: '☀️' };
  if (code <= 2)   return { desc: 'Partly Cloudy',icon: '⛅' };
  if (code === 3)  return { desc: 'Overcast',     icon: '☁️' };
  if (code <= 49)  return { desc: 'Fog',          icon: '🌫️' };
  if (code <= 59)  return { desc: 'Drizzle',      icon: '🌦️' };
  if (code <= 69)  return { desc: 'Rain',         icon: '🌧️' };
  if (code <= 79)  return { desc: 'Snow',         icon: '❄️' };
  if (code <= 84)  return { desc: 'Rain Showers', icon: '🌦️' };
  if (code <= 94)  return { desc: 'Thunderstorm', icon: '⛈️' };
  return            { desc: 'Severe Storm',       icon: '🌩️' };
}

// ── NWS shortForecast / free-text sky → { desc, icon } ───────
function nwsTextToCondition(text) {
  if (text == null) return { desc: null, icon: null };
  const desc = String(text).trim();
  if (!desc || desc === 'undefined') return { desc: null, icon: null };
  const t = desc.toLowerCase();
  let icon = '⛅';
  if (/thunder|tstm/.test(t)) icon = '⛈️';
  else if (/snow|blizzard|flurries|sleet|ice/.test(t)) icon = '❄️';
  else if (/fog|haze|mist/.test(t)) icon = '🌫️';
  else if (/rain|shower|drizzle/.test(t)) icon = '🌧️';
  else if (/(^| )(sunny|clear)( |$)/.test(t) && !/cloud/.test(t)) icon = '☀️';
  else if (/overcast|cloudy/.test(t) && !/partly|mostly sunny|mostly clear/.test(t)) icon = '☁️';
  else if (/partly|mostly cloudy|mostly sunny|mostly clear/.test(t)) icon = '⛅';
  else if (/sunny|clear/.test(t)) icon = '☀️';
  return { desc, icon };
}

// Always return { desc, icon }. Accepts object, string, or missing.
function normalizeCondition(condition) {
  if (condition == null || condition === '') return { desc: null, icon: null };
  if (typeof condition === 'string') return nwsTextToCondition(condition);
  if (typeof condition === 'object') {
    const desc = condition.desc || condition.description || condition.shortForecast || null;
    const icon = condition.icon || null;
    if (desc && !icon) return nwsTextToCondition(desc);
    if ((desc && desc !== 'undefined') || (icon && icon !== 'undefined')) {
      return {
        desc: desc && desc !== 'undefined' ? desc : null,
        icon: icon && icon !== 'undefined' ? icon : null
      };
    }
  }
  return { desc: null, icon: null };
}

function parseNwsSpeedMph(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') {
    const v = raw.value;
    if (v == null || !Number.isFinite(Number(v))) return null;
    const uom = String(raw.unitCode || raw.uom || '');
    const n = Number(v);
    if (uom.includes('km_h')) return Math.round(n * 0.621371 * 10) / 10;
    if (uom.includes('m_s')) return Math.round(n * 2.23694 * 10) / 10;
    return Math.round(n * 10) / 10;
  }
  const n = parseFloat(String(raw));
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

// Expand NWS gridpoint time series (validTime: ISO/PTnH) to UTC hour keys.
function expandNwsGridSeries(values) {
  const map = new Map();
  if (!Array.isArray(values)) return map;
  for (const item of values) {
    if (!item || item.value == null || !item.validTime) continue;
    const [start, duration] = String(item.validTime).split('/');
    const startDate = new Date(start);
    if (Number.isNaN(startDate.getTime())) continue;
    let hours = 1;
    if (duration) {
      const m = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
      if (m) {
        const h = parseInt(m[1] || '0', 10);
        const mins = parseInt(m[2] || '0', 10);
        hours = Math.max(1, h + (mins > 0 ? 1 : 0));
      }
    }
    for (let i = 0; i < hours; i++) {
      const t = new Date(startDate.getTime() + i * 3600000);
      map.set(t.toISOString().slice(0, 13), item.value);
    }
  }
  return map;
}

function kmhToMph(kmh) {
  if (kmh == null || !Number.isFinite(Number(kmh))) return null;
  return Math.round(Number(kmh) * 0.621371 * 10) / 10;
}

function msToMph(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return Math.round(Number(ms) * 2.23694 * 10) / 10;
}

function gridValueToMph(raw, uom) {
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const unit = String(uom || '');
  if (unit.includes('km_h')) return kmhToMph(raw);
  if (unit.includes('m_s-1') || unit.includes('m_s')) return msToMph(raw);
  return Math.round(Number(raw) * 10) / 10;
}

// ── Nominatim Geocoder ───────────────────────────────────────
async function geocode(locationStr) {
  const latLonMatch = locationStr.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (latLonMatch) {
    return { lat: parseFloat(latLonMatch[1]), lon: parseFloat(latLonMatch[2]), display: locationStr };
  }
  const zipMatch = locationStr.match(/^\d{5}(-\d{4})?$/);
  const query = zipMatch
    ? `postalcode=${locationStr}&country=US`
    : `q=${encodeURIComponent(locationStr)}&countrycodes=us`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&${query}&limit=1&addressdetails=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'SprayWeatherApp/2.0 (agricultural spray forecast)' } });
  if (!res.ok) throw new Error('Geocoding failed');
  const data = await res.json();
  if (!data || data.length === 0) throw new Error(`Location not found: ${locationStr}`);
  const place = data[0];
  const addr  = place.address || {};
  const displayParts = [
    addr.city || addr.town || addr.village || addr.county || '',
    addr.state_code || addr.state || '',
  ].filter(Boolean);
  return {
    lat: parseFloat(place.lat),
    lon: parseFloat(place.lon),
    display: displayParts.join(', ') || place.display_name.split(',').slice(0,2).join(',')
  };
}

// ── Open-Meteo API Fetch ─────────────────────────────────────
async function fetchWeather(lat, lon) {
  const hourlyVars = [
    'temperature_2m','apparent_temperature','dew_point_2m',
    'relative_humidity_2m','precipitation_probability','precipitation',
    'cloud_cover','weather_code','wind_speed_10m','wind_gusts_10m',
    'wind_direction_10m','soil_temperature_0cm'
  ].join(',');

  const dailyVars = [
    'temperature_2m_max','temperature_2m_min',
    'apparent_temperature_max','apparent_temperature_min',
    'precipitation_sum','precipitation_probability_max',
    'weather_code','wind_speed_10m_max','wind_gusts_10m_max',
    'wind_direction_10m_dominant','sunrise','sunset'
  ].join(',');

  const url = [
    `https://api.open-meteo.com/v1/forecast`,
    `?latitude=${lat}&longitude=${lon}`,
    `&hourly=${hourlyVars}`,
    `&daily=${dailyVars}`,
    `&forecast_days=7`,
    `&temperature_unit=fahrenheit`,
    `&wind_speed_unit=mph`,
    `&precipitation_unit=inch`,
    `&timezone=auto`
  ].join('');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  return res.json();
}

// ── NWS/NOAA API Fetch (Government weather station data) ────
/**
 * Fetches weather from NWS.
 * 
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<Object>} Formatted NWS data
 * @throws {Error} If fetch fails
 */
async function fetchWeatherNWS(lat, lon) {
  // Get nearest station metadata
  const pointsUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
  const pointsRes = await fetch(pointsUrl, { headers: { 'User-Agent': 'SprayWeatherApp/2.0 (agricultural spray forecast)' } });
  if (!pointsRes.ok) throw new Error(`NWS points error: ${pointsRes.status}`);
  const pointsData = await pointsRes.json();

  // Get hourly forecast (contains periods with time-series data)
  const hourlyUrl = pointsData.properties.forecastHourly;
  const dailyUrl = pointsData.properties.forecast;
  const gridUrl = pointsData.properties.forecastGridData;
  const nwsHeaders = { 'User-Agent': 'SprayWeatherApp/2.0 (agricultural spray forecast)' };

  // Hourly + daily required. Gridpoint is optional (windGust lives here —
  // forecastHourly does not include gusts).
  const fetches = [
    fetch(hourlyUrl, { headers: nwsHeaders }),
    fetch(dailyUrl, { headers: nwsHeaders }),
    gridUrl ? fetch(gridUrl, { headers: nwsHeaders }).catch(() => null) : Promise.resolve(null)
  ];
  const [hourlyRes, dailyRes, gridRes] = await Promise.all(fetches);

  if (!hourlyRes.ok) throw new Error(`NWS hourly error: ${hourlyRes.status}`);
  if (!dailyRes.ok) throw new Error(`NWS daily error: ${dailyRes.status}`);

  const hourlyData = await hourlyRes.json();
  const dailyData = await dailyRes.json();
  let grid = null;
  if (gridRes && gridRes.ok) {
    try {
      const gridData = await gridRes.json();
      grid = gridData.properties || null;
    } catch {
      grid = null;
    }
  }

  return {
    hourly: hourlyData.properties.periods || [],
    daily: dailyData.properties.periods || [],
    tz: pointsData.properties.timeZone,
    grid
  };
}

// ── WeatherAPI.com Fetch (Real-time + forecast, free key needed) ────
async function fetchWeatherWeatherAPI(lat, lon, apiKey = '') {
  // If no API key, fall back to Open-Meteo
  if (!apiKey) throw new Error('WeatherAPI.com requires an API key');
  const url = `https://api.weatherapi.com/v1/forecast.json?key=***&q=${lat},${lon}&days=7&aqi=no&alerts=no`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WeatherAPI error: ${res.status}`);
  return res.json();
}

// ── Normalize Weather Data ──────────────────────────────────
// All fetch functions return data in this unified format for internal processing
function normalizeOpenMeteo(raw) {
  const h = raw.hourly;
  const d = raw.daily;
  const hourCount = Math.min(h.time.length, 96);
  const hourly = [];

  for (let i = 0; i < hourCount; i++) {
    const tempF = h.temperature_2m[i];
    const tempC = (tempF - 32) * 5 / 9;
    const rh = h.relative_humidity_2m[i];
    const deltaT = calcDeltaT(tempC, rh);
    const deltaTF = deltaTtoF(deltaT);

    hourly.push({
      time: h.time[i],
      hour_of_day: new Date(h.time[i]).getHours(),
      temp_f: Math.round(tempF * 10) / 10,
      feels_like_f: Math.round((h.apparent_temperature[i] || tempF) * 10) / 10,
      dew_f: Math.round((h.dew_point_2m[i] || tempF) * 10) / 10,
      rh: Math.round(rh),
      delta_t: Math.round(deltaT * 10) / 10,
      delta_t_f: Math.round(deltaTF * 10) / 10,
      wind_mph: Math.round((h.wind_speed_10m[i] || 0) * 10) / 10,
      gust_mph: Math.round((h.wind_gusts_10m[i] || 0) * 10) / 10,
      wind_dir_deg: h.wind_direction_10m[i],
      wind_dir: degToCardinal(h.wind_direction_10m[i]),
      precip_pct: Math.round(h.precipitation_probability[i] || 0),
      precip_in: Math.round((h.precipitation[i] || 0) * 100) / 100,
      cloud_pct: Math.round(h.cloud_cover[i] || 0),
      weather_code: h.weather_code[i] || 0,
      condition: wmoToCondition(h.weather_code[i] || 0),
      inversion: deltaT < 2 && (h.wind_speed_10m[i] || 0) < 5,
      soil_temp_f: h.soil_temperature_0cm[i] !== undefined ? Math.round(h.soil_temperature_0cm[i]) : null
    });
  }

  const daily = [];
  for (let i = 0; i < d.time.length; i++) {
    daily.push({
      date: d.time[i],
      temp_max_f: Math.round(d.temperature_2m_max[i]),
      temp_min_f: Math.round(d.temperature_2m_min[i]),
      wind_max_mph: Math.round((d.wind_speed_10m_max[i] || 0) * 10) / 10,
      gust_max_mph: Math.round((d.wind_gusts_10m_max[i] || 0) * 10) / 10,
      avg_rh: 50,
      wind_dir_deg: d.wind_direction_10m_dominant[i],
      wind_dir: degToCardinal(d.wind_direction_10m_dominant[i]),
      weather_code: d.weather_code[i] || 0,
      condition: wmoToCondition(d.weather_code[i] || 0),
      sunrise: d.sunrise[i],
      sunset: d.sunset[i],
      soil_temp_f: null
    });
  }

  return {
    hourly,
    daily,
    timezone: raw.timezone || 'America/Chicago',
    utcOffsetSeconds: raw.utc_offset_seconds || 0
  };
}

// ── Normalize NWS Data ──────────────────────────────────────
// NWS returns { periods: [{ startTime, endTime, temperature, windSpeed, ... }] }
// Transform to match normalizeOpenMeteo() output format
function normalizeNWS(raw) {
  const periods = raw.hourly || [];
  const dailyPeriods = raw.daily || [];
  const tz = raw.tz || 'America/Chicago';
  const grid = raw.grid || null;

  const gustUom = grid && grid.windGust ? grid.windGust.uom : '';
  const gustByHour = expandNwsGridSeries(grid && grid.windGust ? grid.windGust.values : []);
  
  // Filter out past periods
  const now = new Date();
  const futurePeriods = periods.filter(p => {
    const startTime = new Date(p.startTime);
    return startTime >= now;
  });
  
  const hourly = [];
  for (const p of futurePeriods.slice(0, 96)) {
    const startTime = new Date(p.startTime);
    const tempF = typeof p.temperature === 'object' ? p.temperature.value : parseFloat(p.temperature);
    const tempC = (tempF - 32) * 5 / 9;
    
    // RH: may be object with .value or direct number
    const rh = typeof p.relativeHumidity === 'object' ? p.relativeHumidity.value : parseFloat(p.relativeHumidity || 50);
    
    // Wind: string like "10 mph" or object with .value
    const windMph = parseNwsSpeedMph(p.windSpeed) ?? 0;
    
    // Gust: forecastHourly almost never includes this. Prefer period value,
    // then gridpoint windGust (real NWS property). Missing → null, never invent.
    let gustMph = parseNwsSpeedMph(p.windGustSpeed);
    if (gustMph == null) gustMph = parseNwsSpeedMph(p.windGust);
    if (gustMph == null) {
      const gustKey = startTime.toISOString().slice(0, 13);
      gustMph = gridValueToMph(gustByHour.get(gustKey), gustUom);
    }
    
    // Wind direction: cardinal string or object with .value (degrees)
    let windDirDeg = null;
    let windDir = null;
    if (p.windDirection) {
      if (typeof p.windDirection === 'object' && p.windDirection.value !== null) {
        windDirDeg = p.windDirection.value;
        windDir = degToCardinal(windDirDeg);
      } else if (typeof p.windDirection === 'string') {
        windDir = p.windDirection;
        windDirDeg = cardinalToDeg(windDir);
      }
    }
    
    // Dewpoint
    let dewF = tempF;
    if (p.dewpoint) {
      const dewC = typeof p.dewpoint === 'object' ? p.dewpoint.value : parseFloat(p.dewpoint);
      dewF = dewC * 9 / 5 + 32;
    }
    
    // Probability of precipitation
    const precipPct = p.probabilityOfPrecipitation ? (typeof p.probabilityOfPrecipitation === 'object' ? p.probabilityOfPrecipitation.value : parseFloat(p.probabilityOfPrecipitation)) : 0;
    
    const deltaT = calcDeltaT(tempC, rh);
    const deltaTF = deltaTtoF(deltaT);
    const condition = nwsTextToCondition(p.shortForecast);
    
    hourly.push({
      time: p.startTime,
      hour_of_day: startTime.getHours(),
      temp_f: Math.round(tempF * 10) / 10,
      feels_like_f: Math.round(tempF * 10) / 10, // NWS doesn't provide apparent temp in hourly
      dew_f: Math.round(dewF * 10) / 10,
      rh: Math.round(rh),
      delta_t: Math.round(deltaT * 10) / 10,
      delta_t_f: Math.round(deltaTF * 10) / 10,
      wind_mph: Math.round(windMph * 10) / 10,
      gust_mph: gustMph,
      wind_dir_deg: windDirDeg,
      wind_dir: windDir,
      precip_pct: Math.round(precipPct),
      precip_in: 0, // NWS doesn't provide precip amount in hourly
      cloud_pct: 50, // NWS doesn't provide cloud cover in hourly, use neutral default
      weather_code: 0,
      condition,
      inversion: deltaT < 2 && windMph < 5,
      soil_temp_f: null // NWS doesn't provide soil temp
    });
  }
  
  const daily = [];
  for (const p of dailyPeriods) {
    const dateStr = p.startTime.split('T')[0];
    const periodTemp = typeof p.temperature === 'object' ? p.temperature.value : parseFloat(p.temperature);
    const temp = Number.isFinite(periodTemp) ? Math.round(periodTemp) : null;
    const isDay = p.isDaytime !== false;
    daily.push({
      date: dateStr,
      temp_max_f: isDay ? temp : null,
      temp_min_f: isDay ? null : temp,
      wind_max_mph: parseNwsSpeedMph(p.windSpeed),
      gust_max_mph: parseNwsSpeedMph(p.windGust) ?? parseNwsSpeedMph(p.windGustSpeed),
      avg_rh: null,
      wind_dir_deg: typeof p.windDirection === 'string' ? cardinalToDeg(p.windDirection) : null,
      wind_dir: typeof p.windDirection === 'string' ? p.windDirection : null,
      weather_code: 0,
      condition: nwsTextToCondition(p.shortForecast),
      sunrise: 'N/A', // NWS doesn't provide sunrise/sunset in forecast
      sunset: 'N/A',
      soil_temp_f: null
    });
  }
  
  return { hourly, daily, timezone: tz, utcOffsetSeconds: 0 };
}

// ── Public spray-window helpers (same scoring, Ops JSON shape) ──

const STATUS_MAP = {
  favorable: 'go',
  caution: 'caution',
  'no-good': 'no-go'
};

function mapHeroStatus(heroStatus) {
  return STATUS_MAP[heroStatus] || 'no-go';
}

function firstQueryValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseCoordinate(value, min, max) {
  if (value === undefined || value === null || value === '') return { ok: false, missing: true };
  const n = typeof value === 'number' ? value : parseFloat(String(value).trim());
  if (!Number.isFinite(n)) return { ok: false, missing: false, invalid: true };
  if (n < min || n > max) return { ok: false, missing: false, outOfRange: true, value: n };
  return { ok: true, value: n };
}

function parseLatLon(query) {
  const q = query || {};
  const latResult = parseCoordinate(firstQueryValue(q.lat), -90, 90);
  const lonResult = parseCoordinate(firstQueryValue(q.lon), -180, 180);
  if (latResult.ok && lonResult.ok) {
    return { ok: true, lat: latResult.value, lon: lonResult.value };
  }
  const latMissing = latResult.missing;
  const lonMissing = lonResult.missing;
  if (latMissing && lonMissing) {
    return { ok: false, missing: true };
  }
  return { ok: false, missing: false, error: 'lat/lon missing or out of range' };
}

function formatOffset(utcOffsetSeconds) {
  const sign = utcOffsetSeconds >= 0 ? '+' : '-';
  const abs = Math.abs(utcOffsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function toISO8601(timeStr, utcOffsetSeconds) {
  if (!timeStr) return null;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(timeStr)) {
    const d = new Date(timeStr);
    return Number.isNaN(d.getTime()) ? timeStr : d.toISOString();
  }
  const base = timeStr.length === 16 ? `${timeStr}:00` : timeStr;
  return `${base}${formatOffset(utcOffsetSeconds || 0)}`;
}

function toOffsetISO(date, utcOffsetSeconds) {
  const offset = utcOffsetSeconds || 0;
  const shifted = new Date(date.getTime() + offset * 1000);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}${formatOffset(offset)}`;
}

function addHoursISO(timeStr, hours, utcOffsetSeconds) {
  const startIso = toISO8601(timeStr, utcOffsetSeconds);
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return startIso;
  d.setTime(d.getTime() + hours * 3600000);
  return toOffsetISO(d, utcOffsetSeconds || 0);
}

function findNextGoWindow(hours, utcOffsetSeconds) {
  if (!hours || hours.length === 0) return null;
  let i = 0;
  while (i < hours.length) {
    if (mapHeroStatus(hours[i].spray && hours[i].spray.status) !== 'go') {
      i += 1;
      continue;
    }
    const start = hours[i].time;
    let j = i;
    while (j < hours.length && mapHeroStatus(hours[j].spray && hours[j].spray.status) === 'go') {
      j += 1;
    }
    const last = hours[j - 1];
    return {
      start: toISO8601(start, utcOffsetSeconds),
      end: addHoursISO(last.time, 1, utcOffsetSeconds)
    };
  }
  return null;
}

function scoreHourly(hourly, product = 'general', method = 'clarity') {
  for (const hour of hourly) {
    hour.spray = scoreSprayConditions(hour, product, method);
  }
  return hourly;
}

function futureHoursFromNow(hourly, now = new Date()) {
  return hourly.filter(h => new Date(h.time) >= now).slice(0, 96);
}

function buildSprayWindowResponse({ lat, lon, hourly, utcOffsetSeconds = 0, fetchedAt = new Date().toISOString() }) {
  const current = hourly[0];
  const heroStatus = current && current.spray ? current.spray.status : 'no-good';
  const status = mapHeroStatus(heroStatus);
  const blockers = (current && current.spray && current.spray.reasons) ? current.spray.reasons.slice() : [];

  return {
    logicVersion: LOGIC_VERSION,
    fetchedAt,
    location: { lat, lon },
    usableNow: status === 'go',
    status,
    blockers,
    nextWindow: findNextGoWindow(hourly, utcOffsetSeconds),
    hours: hourly.map(h => ({
      t: toISO8601(h.time, utcOffsetSeconds),
      status: mapHeroStatus(h.spray && h.spray.status),
      windMph: h.wind_mph,
      windDir: h.wind_dir || '',
      tempF: h.temp_f,
      rh: h.rh,
      deltaT: h.delta_t,
      precipIn: h.precip_in
    }))
  };
}

async function loadScoredForecast(lat, lon, product = 'general', method = 'clarity') {
  const raw = await fetchWeather(lat, lon);
  const norm = normalizeOpenMeteo(raw);
  scoreHourly(norm.hourly, product, method);
  const hourly = futureHoursFromNow(norm.hourly);
  return {
    hourly,
    timezone: norm.timezone,
    utcOffsetSeconds: raw.utc_offset_seconds || 0
  };
}

module.exports = {
  LOGIC_VERSION,
  PRODUCTS,
  scoreSprayConditions,
  calcDeltaT,
  deltaTtoF,
  calcFeelsLike,
  calcSunriseSunset,
  hoursUntilRain,
  degToCardinal,
  cardinalToDeg,
  wmoToCondition,
  nwsTextToCondition,
  normalizeCondition,
  parseNwsSpeedMph,
  expandNwsGridSeries,
  gridValueToMph,
  geocode,
  fetchWeather,
  fetchWeatherNWS,
  fetchWeatherWeatherAPI,
  normalizeOpenMeteo,
  normalizeNWS,
  mapHeroStatus,
  parseLatLon,
  parseCoordinate,
  firstQueryValue,
  toISO8601,
  findNextGoWindow,
  scoreHourly,
  futureHoursFromNow,
  buildSprayWindowResponse,
  loadScoredForecast
};

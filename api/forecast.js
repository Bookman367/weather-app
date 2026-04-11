// ============================================================
// Spray Weather Forecast API — Vercel Serverless Handler
// Calls Open-Meteo (free, no key) + Nominatim geocoder
// Returns full hourly (96h) + daily (7d) structured JSON
// with spray status computed per product label thresholds
// ============================================================

// ── Product Label Thresholds ─────────────────────────────────
// Each product defines: max_wind_mph, max_gust_mph, min_temp_f,
// max_temp_f, min_rh, max_rh, max_precip_pct, max_delta_t,
// min_delta_t, avoid_inversion, notes
const PRODUCTS = {
  general: {
    name: "General (Ag Guidelines)",
    max_wind_mph: 15,
    max_gust_mph: 20,
    min_temp_f: 50,
    max_temp_f: 95,
    min_rh: 30,
    max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true,
    notes: "Standard USDA/Extension ag spray guidelines"
  },
  "2,4-D Amine": {
    name: "2,4-D Amine",
    max_wind_mph: 15,
    max_gust_mph: 20,
    min_temp_f: 60,
    max_temp_f: 85,
    min_rh: 40,
    max_rh: 90,
    max_precip_pct: 25,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true,
    notes: "Common broadleaf killer; temp-sensitive volatility above 85F"
  },
  "Dicamba": {
    name: "Dicamba (Clarity/Banvel)",
    max_wind_mph: 10,
    max_gust_mph: 15,
    min_temp_f: 65,
    max_temp_f: 85,
    min_rh: 40,
    max_rh: 90,
    max_precip_pct: 20,
    min_delta_t: 2,
    max_delta_t: 7,
    avoid_inversion: true,
    notes: "Highly volatile; strict wind & temp limits; avoid near sensitive crops"
  },
  "GrazonNext HL": {
    name: "GrazonNext HL",
    max_wind_mph: 10,
    max_gust_mph: 15,
    min_temp_f: 55,
    max_temp_f: 90,
    min_rh: 40,
    max_rh: 85,
    max_precip_pct: 20,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true,
    notes: "Avoid drift; temps >90F increase volatility (EPA label)"
  },
  "Grazon P+D": {
    name: "Grazon P+D",
    max_wind_mph: 12,
    max_gust_mph: 18,
    min_temp_f: 60,
    max_temp_f: 90,
    min_rh: 35,
    max_rh: 90,
    max_precip_pct: 25,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true,
    notes: "Picloram + 2,4-D combination; moderate wind sensitivity"
  },
  "Roundup (Glyphosate)": {
    name: "Roundup / Glyphosate",
    max_wind_mph: 15,
    max_gust_mph: 20,
    min_temp_f: 50,
    max_temp_f: 95,
    min_rh: 30,
    max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,
    max_delta_t: 10,
    avoid_inversion: false,
    notes: "Most forgiving; avoid rain within 4h of application"
  },
  "Tordon 22K": {
    name: "Tordon 22K (Picloram)",
    max_wind_mph: 10,
    max_gust_mph: 15,
    min_temp_f: 55,
    max_temp_f: 90,
    min_rh: 40,
    max_rh: 90,
    max_precip_pct: 20,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true,
    notes: "Highly persistent; strict drift management required"
  },
  "Remedy Ultra": {
    name: "Remedy Ultra (Triclopyr)",
    max_wind_mph: 12,
    max_gust_mph: 18,
    min_temp_f: 60,
    max_temp_f: 90,
    min_rh: 35,
    max_rh: 90,
    max_precip_pct: 25,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true,
    notes: "Brush/woody plant control; avoid high temp volatility"
  }
};

// ── Spray Condition Scoring ──────────────────────────────────
// Returns: { status: 'favorable'|'caution'|'no-good', reasons: [], score: 0-100 }
function scoreSprayConditions(hour, product) {
  const p = PRODUCTS[product] || PRODUCTS.general;
  const reasons = [];
  let noGood = false;
  let cautionFlags = 0;

  const wind = hour.wind_mph || 0;
  const gust = hour.gust_mph || wind * 1.3;
  const temp = hour.temp_f || 70;
  const rh = hour.rh || 60;
  const precip = hour.precip_pct || 0;
  const deltaT = hour.delta_t || 5;
  const isInversion = hour.inversion || false;

  // ── Hard NO-GOOD triggers ────────────────────────────────
  if (wind > p.max_wind_mph) {
    noGood = true;
    reasons.push(`Wind ${wind.toFixed(0)} mph > max ${p.max_wind_mph} mph`);
  }
  if (gust > p.max_gust_mph) {
    noGood = true;
    reasons.push(`Gusts ${gust.toFixed(0)} mph > max ${p.max_gust_mph} mph`);
  }
  if (temp < p.min_temp_f) {
    noGood = true;
    reasons.push(`Temp ${temp.toFixed(0)}°F below min ${p.min_temp_f}°F`);
  }
  if (temp > p.max_temp_f) {
    noGood = true;
    reasons.push(`Temp ${temp.toFixed(0)}°F above max ${p.max_temp_f}°F`);
  }
  if (precip >= 50) {
    noGood = true;
    reasons.push(`Precip ${precip}% — rain likely`);
  }
  if (p.avoid_inversion && isInversion) {
    noGood = true;
    reasons.push("Temperature inversion detected");
  }

  // ── CAUTION triggers ─────────────────────────────────────
  if (!noGood) {
    if (wind > p.max_wind_mph * 0.75) {
      cautionFlags++;
      reasons.push(`Wind ${wind.toFixed(0)} mph approaching limit`);
    }
    if (gust > p.max_gust_mph * 0.8) {
      cautionFlags++;
      reasons.push(`Gusts ${gust.toFixed(0)} mph — near limit`);
    }
    if (precip >= p.max_precip_pct) {
      cautionFlags++;
      reasons.push(`Precip ${precip}% — above label threshold`);
    } else if (precip >= p.max_precip_pct * 0.6) {
      cautionFlags++;
      reasons.push(`Precip ${precip}% — moderate risk`);
    }
    if (rh < p.min_rh) {
      cautionFlags++;
      reasons.push(`RH ${rh}% below min ${p.min_rh}%`);
    } else if (rh < p.min_rh * 1.15) {
      cautionFlags++;
      reasons.push(`RH ${rh}% near minimum`);
    }
    if (rh > p.max_rh) {
      cautionFlags++;
      reasons.push(`RH ${rh}% above max — absorption risk`);
    }
    if (deltaT < p.min_delta_t) {
      cautionFlags++;
      reasons.push(`Delta-T ${deltaT.toFixed(1)}°C — inversion risk`);
    }
    if (deltaT > p.max_delta_t) {
      cautionFlags++;
      reasons.push(`Delta-T ${deltaT.toFixed(1)}°C — evaporation risk`);
    }
    if (temp > p.max_temp_f * 0.92) {
      cautionFlags++;
      reasons.push(`Temp ${temp.toFixed(0)}°F — near upper limit`);
    }
  }

  // ── Final status ─────────────────────────────────────────
  let status;
  if (noGood) {
    status = 'no-good';
  } else if (cautionFlags >= 1) {
    status = 'caution';
  } else {
    status = 'favorable';
  }

  return { status, reasons, product: p.name };
}

// ── Delta-T Calculator ───────────────────────────────────────
// Delta-T = dry bulb temp - wet bulb temp (°C)
// Optimal spraying: 2-8°C. < 2 = inversion risk, > 8 = evaporation
function calcDeltaT(tempC, rh) {
  // Stull approximation for wet bulb
  const wetBulb = tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
    + Math.atan(tempC + rh)
    - Math.atan(rh - 1.676331)
    + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh)
    - 4.686035;
  return Math.max(0, tempC - wetBulb);
}

// ── Wind direction degrees to cardinal ──────────────────────
function degToCardinal(deg) {
  if (deg === null || deg === undefined) return 'N/A';
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── WMO weather code to description + icon ─────────────────
function wmoToCondition(code) {
  if (code === 0) return { desc: 'Clear', icon: '☀️' };
  if (code <= 2) return { desc: 'Partly Cloudy', icon: '⛅' };
  if (code === 3) return { desc: 'Overcast', icon: '☁️' };
  if (code <= 49) return { desc: 'Fog', icon: '🌫️' };
  if (code <= 59) return { desc: 'Drizzle', icon: '🌦️' };
  if (code <= 69) return { desc: 'Rain', icon: '🌧️' };
  if (code <= 79) return { desc: 'Snow', icon: '❄️' };
  if (code <= 84) return { desc: 'Rain Showers', icon: '🌦️' };
  if (code <= 94) return { desc: 'Thunderstorm', icon: '⛈️' };
  return { desc: 'Severe Storm', icon: '🌩️' };
}

// ── Nominatim Geocoder ───────────────────────────────────────
async function geocode(locationStr) {
  // Try lat,lon parse first
  const latLonMatch = locationStr.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (latLonMatch) {
    return { lat: parseFloat(latLonMatch[1]), lon: parseFloat(latLonMatch[2]), display: locationStr };
  }

  // Zip code pattern
  const zipMatch = locationStr.match(/^\d{5}(-\d{4})?$/);
  const query = zipMatch
    ? `postalcode=${locationStr}&country=US`
    : `q=${encodeURIComponent(locationStr)}&countrycodes=us`;

  const url = `https://nominatim.openstreetmap.org/search?format=json&${query}&limit=1&addressdetails=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SprayWeatherApp/2.0 (agricultural spray forecast)' }
  });
  if (!res.ok) throw new Error('Geocoding failed');
  const data = await res.json();
  if (!data || data.length === 0) throw new Error(`Location not found: ${locationStr}`);

  const place = data[0];
  const addr = place.address || {};
  const displayParts = [
    addr.city || addr.town || addr.village || addr.county || '',
    addr.state_code || addr.state || '',
  ].filter(Boolean);

  return {
    lat: parseFloat(place.lat),
    lon: parseFloat(place.lon),
    display: displayParts.join(', ') || place.display_name.split(',').slice(0, 2).join(',')
  };
}

// ── Open-Meteo API Fetch ─────────────────────────────────────
async function fetchWeather(lat, lon) {
  const hourlyVars = [
    'temperature_2m',
    'dew_point_2m',
    'relative_humidity_2m',
    'precipitation_probability',
    'precipitation',
    'cloud_cover',
    'weather_code',
    'wind_speed_10m',
    'wind_gusts_10m',
    'wind_direction_10m'
  ].join(',');

  const dailyVars = [
    'temperature_2m_max',
    'temperature_2m_min',
    'precipitation_sum',
    'precipitation_probability_max',
    'weather_code',
    'wind_speed_10m_max',
    'wind_gusts_10m_max',
    'wind_direction_10m_dominant'
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

// ── Main Handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Accept GET (with query params) or POST (JSON body)
  let locationStr, herbicide, autoLocate;
  if (req.method === 'GET') {
    locationStr = req.query.location || '';
    herbicide = req.query.herbicide || 'general';
    autoLocate = req.query.auto === 'true';
  } else {
    const body = req.body || {};
    locationStr = body.location || '';
    herbicide = body.herbicide || 'general';
    autoLocate = body.auto || false;
  }

  if (!locationStr && !autoLocate) {
    return res.status(400).json({ error: 'Missing location parameter' });
  }

  try {
    // 1. Geocode
    let geoResult;
    if (autoLocate && (!locationStr || locationStr === 'auto')) {
      // Client-side geolocation was used — lat/lon should be passed as string
      return res.status(400).json({ error: 'Pass lat,lon directly for auto-locate' });
    }
    geoResult = await geocode(locationStr);

    // 2. Fetch weather
    const raw = await fetchWeather(geoResult.lat, geoResult.lon);

    const tzOffset = raw.utc_offset_seconds || 0;
    const product = PRODUCTS[herbicide] || PRODUCTS.general;

    // 3. Process hourly data (96h = 4 days shown in UI, stored 168h)
    const h = raw.hourly;
    const hourCount = Math.min(h.time.length, 96);
    const hourly = [];

    for (let i = 0; i < hourCount; i++) {
      const tempF = h.temperature_2m[i];
      const dewF = h.dew_point_2m[i];
      const tempC = (tempF - 32) * 5 / 9;
      const dewC = (dewF - 32) * 5 / 9;
      const rh = h.relative_humidity_2m[i];
      const deltaT = calcDeltaT(tempC, rh);
      const windMph = h.wind_speed_10m[i];
      const gustMph = h.wind_gusts_10m[i];
      const windDir = h.wind_direction_10m[i];
      const precipPct = h.precipitation_probability[i] || 0;
      const precipIn = h.precipitation[i] || 0;
      const cloudPct = h.cloud_cover[i] || 0;
      const wmoCode = h.weather_code[i] || 0;

      // Inversion detection: delta-T < 2°C proxy
      const inversion = deltaT < 2 && windMph < 5;

      const hourData = {
        time: h.time[i],
        temp_f: Math.round(tempF * 10) / 10,
        dew_f: Math.round(dewF * 10) / 10,
        rh: Math.round(rh),
        delta_t: Math.round(deltaT * 10) / 10,
        wind_mph: Math.round(windMph * 10) / 10,
        gust_mph: Math.round(gustMph * 10) / 10,
        wind_dir_deg: windDir,
        wind_dir: degToCardinal(windDir),
        precip_pct: Math.round(precipPct),
        precip_in: Math.round(precipIn * 1000) / 1000,
        cloud_pct: Math.round(cloudPct),
        weather_code: wmoCode,
        condition: wmoToCondition(wmoCode),
        inversion
      };

      hourData.spray = scoreSprayConditions(hourData, herbicide);
      hourly.push(hourData);
    }

    // 4. Process daily data (7 days)
    const d = raw.daily;
    const daily = [];
    for (let i = 0; i < d.time.length; i++) {
      const maxF = d.temperature_2m_max[i];
      const minF = d.temperature_2m_min[i];
      const precipSum = d.precipitation_sum[i] || 0;
      const precipPct = d.precipitation_probability_max[i] || 0;
      const windMax = d.wind_speed_10m_max[i] || 0;
      const gustMax = d.wind_gusts_10m_max[i] || 0;
      const windDirDom = d.wind_direction_10m_dominant[i];
      const wmoCode = d.weather_code[i] || 0;

      // Daily spray: use midday proxy (avg conditions)
      const avgTemp = (maxF + minF) / 2;
      const dailyHour = {
        temp_f: avgTemp,
        wind_mph: windMax * 0.7, // avg from max
        gust_mph: gustMax,
        rh: 60, // daily RH approximation
        precip_pct: precipPct,
        delta_t: calcDeltaT((avgTemp - 32) * 5 / 9, 60),
        inversion: false
      };

      daily.push({
        date: d.time[i],
        temp_max_f: Math.round(maxF * 10) / 10,
        temp_min_f: Math.round(minF * 10) / 10,
        precip_sum_in: Math.round(precipSum * 100) / 100,
        precip_pct: Math.round(precipPct),
        wind_max_mph: Math.round(windMax * 10) / 10,
        gust_max_mph: Math.round(gustMax * 10) / 10,
        wind_dir: degToCardinal(windDirDom),
        weather_code: wmoCode,
        condition: wmoToCondition(wmoCode),
        spray: scoreSprayConditions(dailyHour, herbicide)
      });
    }

    // 5. Summary stats
    const favorableCount = hourly.filter(h => h.spray.status === 'favorable').length;
    const cautionCount = hourly.filter(h => h.spray.status === 'caution').length;
    const noGoodCount = hourly.filter(h => h.spray.status === 'no-good').length;

    // Best spray window (longest consecutive favorable streak)
    let bestStart = null, bestLen = 0, curStart = null, curLen = 0;
    for (const h of hourly) {
      if (h.spray.status === 'favorable') {
        if (!curStart) curStart = h.time;
        curLen++;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else {
        curStart = null; curLen = 0;
      }
    }

    return res.status(200).json({
      location: {
        display: geoResult.display,
        lat: geoResult.lat,
        lon: geoResult.lon
      },
      product: {
        key: herbicide,
        name: product.name,
        notes: product.notes,
        thresholds: {
          max_wind_mph: product.max_wind_mph,
          max_gust_mph: product.max_gust_mph,
          min_temp_f: product.min_temp_f,
          max_temp_f: product.max_temp_f,
          min_rh: product.min_rh,
          max_rh: product.max_rh,
          max_precip_pct: product.max_precip_pct,
          delta_t_range: `${product.min_delta_t}–${product.max_delta_t}°C`
        }
      },
      summary: {
        favorable_hours: favorableCount,
        caution_hours: cautionCount,
        no_good_hours: noGoodCount,
        best_window_start: bestStart,
        best_window_hours: bestLen
      },
      timezone: raw.timezone,
      hourly,
      daily
    });

  } catch (err) {
    console.error('Forecast error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

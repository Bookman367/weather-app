// ============================================================
// Spray Weather Forecast API — Vercel Serverless Handler
// Calls Open-Meteo (free, no key) + Nominatim geocoder
// Returns full hourly (96h) + daily (7d) structured JSON
// with spray status computed per product label thresholds
// 
// CHANGELOG: 2026-05-02
// - Added structured documentation for NWS fetch logic.
// - Added invocation logging for easier debugging in serverless environments.
// ============================================================

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
    // Clarity: Delta-T 4-18°F (2.2-10°C) is Green
    if (deltaTF < 4) {
      status = 'caution';
      reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F too low — inversion risk (< 4°F)`);
    } else if (deltaTF > 18) {
      status = 'no-good';
      reasons.push(`Clarity Delta-T ${deltaTF.toFixed(1)}°F too high — evaporation risk (> 18°F)`);
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
    reasons.push(`Temp ${tempF.toFixed(0)}°F below minimum (${p.min_temp_f}°F)`);
  } else if (tempF > p.max_temp_f) {
    status = 'no-good';
    reasons.push(`Temp ${tempF.toFixed(0)}°F above maximum (${p.max_temp_f}°F)`);
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

  return { status, reasons, product: p.name };
}

// ── Delta-T: °C (ag standard) and °F equivalent ─────────────
// Delta-T = dry bulb - wet bulb (always in °C by ag convention)
// Optimal spraying: 2–8°C. <2 = inversion risk, >8 = evaporation
/**
     * Calculates the Delta-T based on ambient dry-bulb temperature and relative humidity.
     * Delta-T provides a metric for evaporation rates and drop size stability, critical for spray efficacy.
     * 
     * @param {number} tempC - Ambient temperature in Celsius.
     * @param {number} rh - Relative humidity as a percentage.
     * @returns {number} The calculated Delta-T in Celsius.
     */
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

  // Fetch hourly and daily forecasts in parallel
  const [hourlyRes, dailyRes] = await Promise.all([
    fetch(hourlyUrl, { headers: { 'User-Agent': 'SprayWeatherApp/2.0' } }),
    fetch(dailyUrl, { headers: { 'User-Agent': 'SprayWeatherApp/2.0' } })
  ]);

  if (!hourlyRes.ok) throw new Error(`NWS hourly error: ${hourlyRes.status}`);
  if (!dailyRes.ok) throw new Error(`NWS daily error: ${dailyRes.status}`);

  const hourlyData = await hourlyRes.json();
  const dailyData = await dailyRes.json();

  return {
    hourly: hourlyData.properties.periods || [],
    daily: dailyData.properties.periods || [],
    tz: pointsData.properties.timeZone
  };
}

// ── WeatherAPI.com Fetch (Real-time + forecast, free key needed) ────
async function fetchWeatherWeatherAPI(lat, lon, apiKey = '') {
  // If no API key, fall back to Open-Meteo
  if (!apiKey) throw new Error('WeatherAPI.com requires an API key');
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${lat},${lon}&days=7&aqi=no&alerts=no`;
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
      temp_max_f: Math.round((d.temperature_2m_max[i] || 0) * 10) / 10,
      temp_min_f: Math.round((d.temperature_2m_min[i] || 0) * 10) / 10,
      feels_max_f: Math.round((d.apparent_temperature_max[i] || 0) * 10) / 10,
      feels_min_f: Math.round((d.apparent_temperature_min[i] || 0) * 10) / 10,
      precip_sum_in: Math.round((d.precipitation_sum[i] || 0) * 100) / 100,
      precip_pct: Math.round(d.precipitation_probability_max[i] || 0),
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

  return { hourly, daily, timezone: raw.timezone || 'America/Chicago' };
}

// ── Main Handler ─────────────────────────────────────────────
/**
 * Main API Handler for Spray Weather Forecast.
 * Integrates various weather providers (Open-Meteo, NWS, WeatherAPI) to deliver
 * localized spray suitability forecasts based on EPA label chemical thresholds.
 */
export default async function handler(req, res) {
  console.log(`Spray Weather Forecast API invoked: ${req.method} request received at ${new Date().toISOString()}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let locationStr, herbicide, method, source, sunriseOffset, sunsetOffset;
  if (req.method === 'GET') {
    locationStr = req.query.location || '';
    herbicide   = req.query.herbicide || 'general';
    method      = req.query.method || 'clarity';
    source      = req.query.source || 'nws';
    sunriseOffset = parseInt(req.query.sunriseOffset || '0');
    sunsetOffset  = parseInt(req.query.sunsetOffset || '2');
  } else {
    const body  = req.body || {};
    locationStr = body.location || '';
    herbicide   = body.herbicide || 'general';
    method      = body.method || 'clarity';
    source      = body.source || 'nws';
    sunriseOffset = parseInt(body.sunriseOffset || '0');
    sunsetOffset  = parseInt(body.sunsetOffset || '2');
  }
  if (!locationStr) return res.status(400).json({ error: 'Missing location parameter' });

  try {
    const geoResult = await geocode(locationStr);
    let raw, tzOffset;

    // Fetch from selected weather source
    switch (source) {
      case 'openmeteo':
        raw = await fetchWeather(geoResult.lat, geoResult.lon);
        const normalized = normalizeOpenMeteo(raw);
        tzOffset = raw.utc_offset_seconds || 0;
        var hourly = normalized.hourly;
        var daily = normalized.daily;
        var timezone = normalized.timezone;
        break;
      case 'weatherapi':
        // Note: WeatherAPI.com requires a free API key
        // For now, fall back to NWS if no key provided
        const apiKey = process.env.WEATHERAPI_KEY || '';
        if (apiKey) {
          raw = await fetchWeatherWeatherAPI(geoResult.lat, geoResult.lon, apiKey);
          // Normalize WeatherAPI format (simplified)
          tzOffset = 0;
          var hourly = []; var daily = [];
          // WeatherAPI structure processing would go here
        } else {
          throw new Error('WeatherAPI key not configured');
        }
        break;
      case 'nws':
      default:
        // NWS/NOAA - Government weather station + forecast data
        const nwsData = await fetchWeatherNWS(geoResult.lat, geoResult.lon);
        tzOffset = 0;
        // Normalize NWS hourly format (periods array)
        var hourly = [];
        const nowNWS = new Date();
        for (const p of nwsData.hourly) {
          // Skip periods in the past
          if (new Date(p.startTime) < nowNWS) continue;
          const tempF = parseFloat(p.temperature);
          const rh = p.relativeHumidity?.value || 50;
          const dewC = p.dewpoint?.value || (tempF - 32) * 5 / 9;
          const dewF = dewC * 9 / 5 + 32;
          const deltaT = calcDeltaT((tempF - 32) * 5 / 9, rh);
          const windSpeedStr = p.windSpeed || '0 mph';
          const windSpeed = parseFloat(windSpeedStr.replace(' mph', '')) || 0;
          // Parse wind gusts - NWS may provide windGustSpeed
          const gustSpeedStr = p.windGustSpeed || p.windGust || '';
          let gustSpeed = 0;
          if (gustSpeedStr) {
            gustSpeed = parseFloat(gustSpeedStr.replace(' mph', '').replace('G', '')) || 0;
          }
          // Parse wind direction from NWS — may be cardinal string ("SSW") or {value: degrees}
          const rawWindDir = p.windDirection?.value ?? p.windDirection ?? null;
          const windDirDeg = cardinalToDeg(rawWindDir);
          hourly.push({
            time: new Date(p.startTime).toISOString(),
            temp_f: tempF,
            feels_like_f: p.apparentTemperature || tempF,
            dew_f: Math.round(dewF),
            rh: Math.round(rh),
            delta_t: Math.round(deltaT * 10) / 10,
            delta_t_f: Math.round(deltaTtoF(deltaT) * 10) / 10,
            wind_mph: windSpeed,
            gust_mph: gustSpeed || windSpeed,
            wind_dir_deg: windDirDeg,
            wind_dir: degToCardinal(windDirDeg),
            precip_pct: p.probabilityOfPrecipitation?.value || 0,
            precip_in: 0,
            cloud_pct: 50,
            weather_code: 0,
            condition: { desc: p.shortForecast, icon: '🌤️' },
            inversion: deltaT < 2 && windSpeed < 5,
            soil_temp_f: null
          });
        }
        // Normalize NWS daily format (periods are 12hr chunks, need daily aggregation)
        var daily = [];
        var dayMap = new Map();
        for (const p of nwsData.daily) {
          const dateStr = p.startTime ? p.startTime.split('T')[0] : '';
          if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
          dayMap.get(dateStr).push(p);
        }
        for (const [dateStr, dayPeriods] of dayMap.entries()) {
          const maxF = Math.max(...dayPeriods.map(p => parseFloat(p.temperature)));
          const minF = Math.min(...dayPeriods.map(p => parseFloat(p.temperature)));
          const avgRH = dayPeriods.reduce((s, p) => s + (p.relativeHumidity?.value || 50), 0) / dayPeriods.length;
          const avgTemp = (maxF + minF) / 2;
          const deltaT = calcDeltaT((avgTemp - 32) * 5 / 9, avgRH);
          const samplePeriod = dayPeriods[0];
          // Parse wind info from NWS daily period
          const dayWindStr = samplePeriod?.windSpeed || '0 mph';
          const dayWind = parseFloat(dayWindStr.replace(' mph', '')) || 0;
          const dayGustStr = samplePeriod?.windGustSpeed || samplePeriod?.windGust || '';
          const dayGust = dayGustStr ? parseFloat(dayGustStr.replace(' mph', '').replace('G', '')) || dayWind : dayWind;
          const dayWindDirRaw = samplePeriod?.windDirection?.value ?? samplePeriod?.windDirection ?? null;
          const dayWindDir = cardinalToDeg(dayWindDirRaw);
          daily.push({
            date: dateStr,
            temp_max_f: maxF,
            temp_min_f: minF,
            feels_max_f: maxF,
            feels_min_f: minF,
            precip_sum_in: 0,
            precip_pct: samplePeriod?.probabilityOfPrecipitation?.value || 0,
            wind_max_mph: dayWind,
            gust_max_mph: dayGust,
            avg_rh: Math.round(avgRH),
            wind_dir_deg: dayWindDir,
            wind_dir: degToCardinal(dayWindDir),
            weather_code: 0,
            condition: { desc: samplePeriod?.shortForecast || 'Varied', icon: '⛅' },
            sunrise: '',
            sunset: '',
            soil_temp_f: null
          });
        }
        var timezone = nwsData.tz;
        break;
    }

    const product = PRODUCTS[herbicide] || PRODUCTS.general;

    // Add spray conditions to each hour
    for (const hour of hourly) {
      hour.spray = scoreSprayConditions(hour, herbicide, method);
    }

    // Time alignment: return only the next 96 hours starting from now
    const now = new Date();
    const futureHourly = hourly.filter(h => new Date(h.time) >= now);
    const hourlyFinal = futureHourly.slice(0, 96);

    // ── Hours until rain ─────────────────────────────────
    const rainIn = hoursUntilRain(hourlyFinal, 30);

    // ── Active inversion alert ────────────────────────────
    const inversionNow = hourlyFinal[0]?.inversion || false;
    const inversionAlert = inversionNow ? {
      active: true,
      delta_t:   hourlyFinal[0].delta_t,
      delta_t_f: hourlyFinal[0].delta_t_f,
      wind_mph:  hourlyFinal[0].wind_mph,
      message:   `Temperature inversion conditions detected. Delta-T ${hourlyFinal[0].delta_t}°C (${hourlyFinal[0].delta_t_f}°F spread) with winds at ${hourlyFinal[0].wind_mph} mph. Spray droplets may pool and drift unpredictably. Do not apply.`
    } : { active: false };

    // ── Parse sunrise/sunset times to LOCAL hour-of-day integers ────
    // Used with daytimeHours() which also uses getHours() (local time)
    function parseSunHour(timeStr) {
      if (!timeStr || timeStr === 'N/A') return null;
      if (timeStr.includes('T')) {
        // Open-Meteo full timestamp: "2026-05-03T06:12:00"
        // Parse hour+minute directly from string to avoid server-TZ issues
        const parts = timeStr.split('T')[1].split(':');
        return parseInt(parts[0]) + parseInt(parts[1]) / 60;
      }
      // NWS "6:42 AM" format — already local time
      const m = timeStr.match(/(\d+):(\d+)\s*([AP]M)/);
      if (!m) return null;
      let h = parseInt(m[1]);
      if (m[3] === 'PM' && h !== 12) h += 12;
      if (m[3] === 'AM' && h === 12) h = 0;
      return h + parseInt(m[2]) / 60;
    }

    // ── Sprayable daytime window helper ────────────────────────────────
    // JD sprays sunrise → sunset+offset. Returns hours from dayHours within that window.
    // sunriseOffset: hours after sunrise to start (can be negative = before sunrise)
    // sunsetOffset: hours after sunset to end (can be negative = before sunset)
    function daytimeHours(dayHours, sunriseStr, sunsetStr, sunriseOffset = 0, sunsetOffset = 2) {
      if (!sunriseStr || sunriseStr === 'N/A' || !sunsetStr || sunsetStr === 'N/A') {
        return dayHours; // fallback: use all hours if sun times unavailable
      }
      const sunriseH = parseSunHour(sunriseStr);
      const rawSunsetH = parseSunHour(sunsetStr);
      if (sunriseH === null || rawSunsetH === null) return dayHours;

      const startSprayH = (sunriseH + sunriseOffset + 24) % 24;
      const endSprayH = (rawSunsetH + sunsetOffset + 24) % 24;

      return dayHours.filter(h => {
        // h.time is stored as an ISO UTC string from both NWS and Open-Meteo.
        // On a UTC server, getHours() returns UTC hour = correct for NWS (already UTC).
        // For Open-Meteo, h.time is local time but interpreted as UTC on a UTC server,
        // so getHours() gives the local hour value (6 for CDT 6:00) which matches
        // the local-hour parseSunHour output — the two are consistent on a UTC server.
        const hour = new Date(h.time).getHours();
        if (startSprayH <= endSprayH) {
          // Window doesn't wrap midnight
          return hour >= startSprayH && hour <= endSprayH;
        } else {
          // Window wraps past midnight
          return hour >= startSprayH || hour <= endSprayH;
        }
      });
    }

    // ── Majority-rule daily status ────────────────────────────────────
    // "What the majority of hours show = what the day shows"
    function majorityDayStatus(daySprayHours) {
      if (!daySprayHours || daySprayHours.length === 0) return 'favorable';
      const counts = { favorable: 0, caution: 0, 'no-good': 0 };
      for (const h of daySprayHours) {
        counts[h.spray.status] = (counts[h.spray.status] || 0) + 1;
      }
      // Majority wins
      if (counts['no-good'] > counts.favorable && counts['no-good'] > counts.caution) return 'no-good';
      if (counts.caution > counts.favorable && counts.caution > counts['no-good']) return 'caution';
      if (counts.favorable > counts['no-good'] && counts.favorable > counts.caution) return 'favorable';
      // Tie-breaker: use the worse of the tied statuses
      if (counts.favorable === counts.caution && counts.favorable > counts['no-good']) return 'caution';
      if (counts.favorable === counts['no-good'] && counts.favorable > counts.caution) return 'caution';
      if (counts.caution === counts['no-good'] && counts.caution > counts.favorable) return 'no-good';
      return 'favorable';
    }

    // ── Process daily (7 days) ────────────────────────────
    // If daily was populated by the source switch, use it; otherwise aggregate from hourly
    if (daily.length === 0) {
      // Aggregate daily data from hourly
      const dayMap = new Map();
      for (const h of hourlyFinal) {
        const dateStr = h.time.split('T')[0];
        if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
        dayMap.get(dateStr).push(h);
      }

      for (const [dateStr, dayHours] of dayMap.entries()) {
        const maxF = Math.max(...dayHours.map(h => h.temp_f));
        const minF = Math.min(...dayHours.map(h => h.temp_f));
        const avgRH = Math.round(dayHours.reduce((s, h) => s + h.rh, 0) / dayHours.length);
        const sunTimes = calcSunriseSunset(geoResult.lat, geoResult.lon, dateStr, tzOffset);

        // Filter to daytime sprayable window
        const daySprayHours = daytimeHours(dayHours, sunTimes.sunrise, sunTimes.sunset, sunriseOffset, sunsetOffset);

        // Score using daytime window hours (if none, fall back to all hours)
        const scoringHours = daySprayHours.length > 0 ? daySprayHours : dayHours;

        // Use actual worst-case values for key thresholds from daytime window
        const maxWind = Math.max(...scoringHours.map(h => h.wind_mph));
        const maxGust = Math.max(...scoringHours.map(h => h.gust_mph));
        const maxPrecip = Math.max(...scoringHours.map(h => h.precip_pct || 0));
        const worstDeltaT = scoringHours.reduce((worst, h) => {
          if (!worst) return h.delta_t;
          return h.delta_t > worst ? h.delta_t : worst;
        }, null);
        const avgTemp = (maxF + minF) / 2;
        const deltaT = calcDeltaT((avgTemp - 32) * 5 / 9, avgRH);

        const sprayObj = scoreSprayConditions({
          temp_f: avgTemp,
          wind_mph: maxWind,
          gust_mph: maxGust,
          rh: avgRH,
          precip_pct: maxPrecip,
          delta_t: worstDeltaT !== null ? worstDeltaT : deltaT,
          delta_t_f: deltaTtoF(worstDeltaT !== null ? worstDeltaT : deltaT)
        }, herbicide, method);

        // Majority-rule daily status
        const overallStatus = majorityDayStatus(daySprayHours);

        const allReasons = daySprayHours
          .flatMap(h => h.spray.reasons)
          .filter((r, i, a) => a.indexOf(r) === i); // dedupe

        daily.push({
          date: dateStr,
          temp_max_f: maxF,
          temp_min_f: minF,
          feels_max_f: maxF,
          feels_min_f: minF,
          precip_sum_in: 0,
          precip_pct: maxPrecip,
          wind_max_mph: maxWind,
          gust_max_mph: maxGust,
          avg_rh: avgRH,
          wind_dir: 'N',
          weather_code: 0,
          condition: { desc: 'Varied', icon: '⛅' },
          sunrise: sunTimes.sunrise,
          sunset: sunTimes.sunset,
          soil_temp_f: null,
          spray: {
            status: overallStatus,
            reasons: allReasons.length > 0 ? allReasons : sprayObj.reasons,
            product: sprayObj.product
          }
        });
      }
    } else {
      // NWS / WeatherAPI daily path: score using actual wind/gust/precip data
      for (const day of daily) {
        // Derive daytime window hours from the hourly data for this day
        const dayDateStr = day.date;
        const dayHours = hourlyFinal.filter(h => h.time.split('T')[0] === dayDateStr);
        const daySprayHours = daytimeHours(dayHours, day.sunrise, day.sunset, sunriseOffset, sunsetOffset);
        const scoringHours = daySprayHours.length > 0 ? daySprayHours : dayHours;

        // Use actual max values from daytime window
        const maxWind = day.wind_max_mph;
        const maxGust = day.gust_max_mph;
        const maxPrecip = day.precip_pct || 0;

        // Calculate delta_t from avg conditions if not present
        const avgTemp = (day.temp_max_f + day.temp_min_f) / 2;
        const avgRH = day.avg_rh || 50;
        const deltaT = calcDeltaT((avgTemp - 32) * 5 / 9, avgRH);

        const sprayObj = scoreSprayConditions({
          temp_f: avgTemp,
          wind_mph: maxWind,
          gust_mph: maxGust,
          rh: avgRH,
          precip_pct: maxPrecip,
          delta_t: deltaT,
          delta_t_f: deltaTtoF(deltaT)
        }, herbicide, method);

        const overallStatus = majorityDayStatus(daySprayHours);

        const allReasons = daySprayHours
          .flatMap(h => h.spray.reasons)
          .filter((r, i, a) => a.indexOf(r) === i);

        day.spray = {
          status: overallStatus,
          reasons: allReasons.length > 0 ? allReasons : sprayObj.reasons,
          product: sprayObj.product
        };
      }
    }

    // ── Summary stats ─────────────────────────────────────
    const favorableCount = hourlyFinal.filter(h => h.spray.status === 'favorable').length;
    const cautionCount   = hourlyFinal.filter(h => h.spray.status === 'caution').length;
    const noGoodCount    = hourlyFinal.filter(h => h.spray.status === 'no-good').length;

    let bestStart = null, bestLen = 0, curStart = null, curLen = 0;
    for (const h of hourlyFinal) {
      if (h.spray.status === 'favorable') {
        if (!curStart) curStart = h.time;
        curLen++;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else { curStart = null; curLen = 0; }
    }

    return res.status(200).json({
      location: {
        display: geoResult.display,
        lat: geoResult.lat,
        lon: geoResult.lon
      },
      product: {
        key:   herbicide,
        name:  product.name,
        notes: product.notes,
        thresholds: {
          max_wind_mph:  product.max_wind_mph,
          max_gust_mph:  product.max_gust_mph,
          min_temp_f:    product.min_temp_f,
          max_temp_f:    product.max_temp_f,
          min_rh:        product.min_rh,
          max_rh:        product.max_rh,
          max_precip_pct:product.max_precip_pct,
          delta_t_range: `${product.min_delta_t}–${product.max_delta_t}°C  (${deltaTtoF(product.min_delta_t).toFixed(1)}–${deltaTtoF(product.max_delta_t).toFixed(1)}°F spread)`
        }
      },
      summary: {
        favorable_hours:    favorableCount,
        caution_hours:      cautionCount,
        no_good_hours:      noGoodCount,
        best_window_start:  bestStart,
        best_window_hours:  bestLen,
        hours_until_rain:   rainIn,   // null = no rain in 96h window
      },
      inversion_alert: inversionAlert,
      timezone: timezone || 'America/Chicago',
      sprayWindow: {
        sunriseOffset,
        sunsetOffset
      },
      hourly: hourlyFinal,
      daily
    });

  } catch (err) {
    console.error('Forecast error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

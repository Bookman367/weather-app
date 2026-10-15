const {
  scoreHourly,
  normalizeOpenMeteo,
  calcSunriseSunset
} = require('../lib/spray-logic');

// Open-Meteo forecast_days max is 16. Daily uses the full 16-day set.
// Hourly view stays at 7 days (168h) so the client payload stays small.
const FORECAST_DAYS = 16;
const HOURLY_DAYS = 7;
const HOURLY_LIMIT = HOURLY_DAYS * 24;
const FETCH_HOURS = FORECAST_DAYS * 24;
const CONFIDENT_DAYS = 7;

// Hero daily spray window defaults (same as /api/forecast):
// sunrise + 0h through sunset + 2h.
const DEFAULT_SUNRISE_OFFSET = 0;
const DEFAULT_SUNSET_OFFSET = 2;

// Simple in-memory cache
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const cache = new Map();

const HOURLY_VARS = [
  'temperature_2m','apparent_temperature','dew_point_2m',
  'relative_humidity_2m','precipitation_probability','precipitation',
  'cloud_cover','weather_code','wind_speed_10m','wind_gusts_10m',
  'wind_direction_10m','soil_temperature_0cm'
].join(',');

const DAILY_VARS = [
  'temperature_2m_max','temperature_2m_min',
  'apparent_temperature_max','apparent_temperature_min',
  'precipitation_sum','precipitation_probability_max',
  'weather_code','wind_speed_10m_max','wind_gusts_10m_max',
  'wind_direction_10m_dominant','sunrise','sunset'
].join(',');

function buildForecastUrl(lats, lons) {
  return [
    `https://api.open-meteo.com/v1/forecast`,
    `?latitude=${lats}&longitude=${lons}`,
    `&hourly=${HOURLY_VARS}`,
    `&daily=${DAILY_VARS}`,
    `&forecast_days=${FORECAST_DAYS}`,
    `&temperature_unit=fahrenheit`,
    `&wind_speed_unit=mph`,
    `&precipitation_unit=inch`,
    `&timezone=auto`
  ].join('');
}

function hourStatus(hour) {
  if (hour && hour.spray && hour.spray.status) return hour.spray.status;
  return hour && hour.status;
}

function hourReasons(hour) {
  if (hour && hour.reasons && hour.reasons.length) return hour.reasons;
  if (hour && hour.spray && hour.spray.reasons) return hour.spray.reasons;
  return [];
}

function hourOfDay(hour) {
  if (hour && typeof hour.hour_of_day === 'number') return hour.hour_of_day;
  const match = String(hour && hour.time || '').match(/T(\d{2})/);
  return match ? parseInt(match[1], 10) : 0;
}

function formatHourShort(time) {
  const match = String(time || '').match(/T(\d{2})/);
  const hr = match ? parseInt(match[1], 10) : 0;
  const hr12 = hr % 12 || 12;
  const ampm = hr < 12 ? 'a' : 'p';
  return `${hr12}${ampm}`;
}

function parseSunHour(sunStr) {
  if (!sunStr || typeof sunStr !== 'string') return null;
  const m = sunStr.match(/(\d+):(\d+)\s+(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return h + parseInt(m[2], 10) / 60;
}

// Same daytime window used by /api/forecast (Hero daily spray hours).
function daytimeHours(dayHours, sunriseStr, sunsetStr, sunriseOffset, sunsetOffset) {
  if (!sunriseStr || !sunsetStr || sunriseStr === 'N/A' || sunsetStr === 'N/A') return dayHours;
  const sunriseH = parseSunHour(sunriseStr);
  const rawSunsetH = parseSunHour(sunsetStr);
  if (sunriseH === null || rawSunsetH === null) return dayHours;

  const startSprayH = (sunriseH + sunriseOffset + 24) % 24;
  const endSprayH = (rawSunsetH + sunsetOffset + 24) % 24;

  return dayHours.filter(h => {
    const hour = hourOfDay(h);
    if (startSprayH < endSprayH) {
      return hour >= startSprayH && hour <= endSprayH;
    }
    return hour >= startSprayH || hour <= endSprayH;
  });
}

// Copied from /api/forecast — "what the majority of hours show = what the day shows"
function majorityDayStatus(daySprayHours) {
  if (!daySprayHours || daySprayHours.length === 0) return 'favorable';
  const counts = { favorable: 0, caution: 0, 'no-good': 0 };
  for (const h of daySprayHours) {
    const status = hourStatus(h);
    if (counts[status] !== undefined) counts[status]++;
  }
  if (counts['no-good'] > counts.favorable && counts['no-good'] > counts.caution) return 'no-good';
  if (counts.caution > counts.favorable && counts.caution > counts['no-good']) return 'caution';
  if (counts.favorable === counts['no-good'] && counts.favorable > counts.caution) return 'caution';
  if (counts.caution === counts['no-good'] && counts.caution > counts.favorable) return 'no-good';
  return 'favorable';
}

const STATUS_RANK = { favorable: 0, caution: 1, 'no-good': 2 };

function worstCaseStatus(dayHours) {
  let worst = 'favorable';
  for (const h of dayHours || []) {
    const status = hourStatus(h);
    if ((STATUS_RANK[status] || 0) > (STATUS_RANK[worst] || 0)) worst = status;
  }
  return worst;
}

function findBestWindow(dayHours, wanted = 'favorable') {
  let best = null;
  let current = [];
  for (const h of dayHours || []) {
    if (hourStatus(h) === wanted) {
      current.push(h);
    } else {
      if (current.length > (best ? best.length : 0)) best = current;
      current = [];
    }
  }
  if (current.length > (best ? best.length : 0)) best = current;
  if (!best || best.length === 0) return null;
  const last = best[best.length - 1];
  return {
    start: best[0].time,
    end: last.time,
    startLabel: formatHourShort(best[0].time),
    endLabel: formatHourShort(last.time),
    hours: best.length,
    status: wanted
  };
}

function finiteNums(values) {
  return values.filter(v => v != null && Number.isFinite(Number(v))).map(Number);
}

function rollupDaily(hourly, options = {}) {
  const {
    lat,
    lon,
    utcOffsetSeconds = 0,
    sunriseOffset = DEFAULT_SUNRISE_OFFSET,
    sunsetOffset = DEFAULT_SUNSET_OFFSET
  } = options;

  const byDate = new Map();
  for (const h of hourly || []) {
    const date = String(h.time || '').slice(0, 10);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(h);
  }

  const days = [];
  for (const [date, hours] of byDate) {
    let scoringHours = hours;
    if (lat != null && lon != null) {
      const sun = calcSunriseSunset(lat, lon, date, utcOffsetSeconds);
      const dayHours = daytimeHours(hours, sun.sunrise, sun.sunset, sunriseOffset, sunsetOffset);
      if (dayHours.length > 0) scoringHours = dayHours;
    }

    const status = majorityDayStatus(scoringHours);
    const worstStatus = worstCaseStatus(scoringHours);
    const bestGo = findBestWindow(scoringHours, 'favorable');
    const bestCaution = findBestWindow(scoringHours, 'caution');
    const bestWindow = bestGo || bestCaution;

    const goHours = scoringHours
      .filter(h => hourStatus(h) === 'favorable')
      .map(h => ({ time: h.time, label: formatHourShort(h.time) }));

    const reasons = [];
    const seen = new Set();
    for (const h of scoringHours) {
      for (const reason of hourReasons(h)) {
        if (!seen.has(reason)) {
          seen.add(reason);
          reasons.push(reason);
        }
      }
    }

    const temps = finiteNums(hours.map(h => h.temp ?? h.temp_f));
    const winds = finiteNums(hours.map(h => h.wind ?? h.wind_mph));
    const gusts = finiteNums(hours.map(h => h.gust ?? h.gust_mph));
    const rhs = finiteNums(hours.map(h => h.rh));
    const precips = finiteNums(hours.map(h => h.precip ?? h.precip_pct));

    days.push({
      date,
      status,
      worstStatus,
      bestWindow,
      goHours,
      goCount: goHours.length,
      hourCount: scoringHours.length,
      reasons,
      temp: temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : null,
      tempMin: temps.length ? Math.min(...temps) : null,
      tempMax: temps.length ? Math.max(...temps) : null,
      wind: winds.length ? Math.max(...winds) : null,
      gust: gusts.length ? Math.max(...gusts) : null,
      rh: rhs.length ? Math.round(rhs.reduce((a, b) => a + b, 0) / rhs.length) : null,
      precip: precips.length ? Math.max(...precips) : null
    });
  }

  return days;
}

function markLowerConfidence(days, confidentDays = CONFIDENT_DAYS) {
  return (days || []).map((day, i) => ({
    ...day,
    lowerConfidence: i >= confidentDays
  }));
}

// Score the full 16-day hourly set, then keep only 7 days of hours for the
// Hourly strip. Daily rollup uses every scored hour.
function applyViewWindows(scoredHours, rollupOptions = {}) {
  const daily = markLowerConfidence(rollupDaily(scoredHours, rollupOptions), CONFIDENT_DAYS);
  const hourly = (scoredHours || []).slice(0, HOURLY_LIMIT);
  return { hourly, daily };
}

function getCacheKey(lat, lon, radius, product) {
  // Round lat/lon to ~0.05 degrees (approx 3.5 miles) to increase cache hits
  // when users pan slightly.
  const rLat = Math.round(lat * 20) / 20;
  const rLon = Math.round(lon * 20) / 20;
  return `${rLat}_${rLon}_${radius}_${product}`;
}

function generateGrid(centerLat, centerLon, radiusMiles, gridSize = 7) {
  const latDegreeMiles = 69.0;
  const lonDegreeMiles = 69.0 * Math.cos(centerLat * Math.PI / 180);

  const latDelta = radiusMiles / latDegreeMiles;
  const lonDelta = radiusMiles / lonDegreeMiles;

  const minLat = centerLat - latDelta;
  const maxLat = centerLat + latDelta;
  const minLon = centerLon - lonDelta;
  const maxLon = centerLon + lonDelta;

  const points = [];
  const latStep = (maxLat - minLat) / (gridSize - 1);
  const lonStep = (maxLon - minLon) / (gridSize - 1);

  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const lat = minLat + (i * latStep);
      const lon = minLon + (j * lonStep);

      const cellMinLat = lat - (latStep / 2);
      const cellMaxLat = lat + (latStep / 2);
      const cellMinLon = lon - (lonStep / 2);
      const cellMaxLon = lon + (lonStep / 2);

      points.push({
        lat: Number(lat.toFixed(5)),
        lon: Number(lon.toFixed(5)),
        bounds: [
          [Number(cellMinLat.toFixed(5)), Number(cellMinLon.toFixed(5))],
          [Number(cellMaxLat.toFixed(5)), Number(cellMaxLon.toFixed(5))]
        ]
      });
    }
  }

  return points;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const cacheHeader = 'public, s-maxage=900, stale-while-revalidate=1800';
  res.setHeader('Cache-Control', cacheHeader);
  res.setHeader('CDN-Cache-Control', cacheHeader);
  res.setHeader('Vercel-CDN-Cache-Control', cacheHeader);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const query = req.query || {};
  let lat = parseFloat(query.lat);
  let lon = parseFloat(query.lon);
  const radius = parseInt(query.radius, 10) || 30; // 30 or 60 miles
  const product = query.product || 'general';

  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Invalid or missing lat/lon' });
  }

  if (radius !== 30 && radius !== 60) {
    return res.status(400).json({ error: 'Radius must be 30 or 60' });
  }

  const cacheKey = getCacheKey(lat, lon, radius, product);
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
    return res.status(200).json(cached.data);
  }

  try {
    const points = generateGrid(lat, lon, radius, 7); // 7x7 grid = 49 points

    // Open-Meteo allows batched requests by passing comma-separated lat/lon arrays.
    const lats = points.map(p => p.lat).join(',');
    const lons = points.map(p => p.lon).join(',');

    // One batched Open-Meteo call for the whole 7x7 grid (16-day hourly).
    const url = buildForecastUrl(lats, lons);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Open-Meteo API error: ${response.status}`);
    }

    const rawData = await response.json();

    // When multiple coordinates are requested, Open-Meteo returns an array of objects
    const resultsArray = Array.isArray(rawData) ? rawData : [rawData];

    if (resultsArray.length !== points.length) {
      throw new Error(`Expected ${points.length} results, got ${resultsArray.length}`);
    }

    const scoredPoints = points.map((p, index) => {
      const rawLocationData = resultsArray[index];
      const norm = normalizeOpenMeteo(rawLocationData, FETCH_HOURS);

      // Open-Meteo returns time strings in local time when timezone=auto.
      // To accurately filter past hours, we compare them against the current local time.
      const currentLocalTime = new Date(Date.now() + norm.utcOffsetSeconds * 1000);
      // Create an ISO-like string YYYY-MM-DDTHH:00 to match Open-Meteo's format
      const localIso = currentLocalTime.toISOString().slice(0, 14) + "00";

      // Score the full 16-day hourly set (needed for Daily), then cap Hourly at 168h.
      const futureHours = norm.hourly.filter(h => h.time >= localIso).slice(0, FETCH_HOURS);

      // Score with Hero spray rules (Clarity method + product label thresholds).
      const scoredHourly = scoreHourly(futureHours, product, 'clarity');

      // Map down to what the frontend needs to save bandwidth
      const simplifiedAll = scoredHourly.map(h => ({
        time: h.time,
        status: h.spray.status,
        reasons: h.spray.reasons,
        temp: h.temp_f,
        wind: h.wind_mph,
        gust: h.gust_mph,
        rh: h.rh,
        precip: h.precip_pct
      }));

      const windows = applyViewWindows(simplifiedAll, {
        lat: p.lat,
        lon: p.lon,
        utcOffsetSeconds: norm.utcOffsetSeconds
      });

      return {
        ...p,
        hourly: windows.hourly,
        daily: windows.daily
      };
    });

    const data = {
      center: { lat, lon },
      radius,
      product,
      forecastDays: FORECAST_DAYS,
      forecastHours: HOURLY_LIMIT,
      confidentDays: CONFIDENT_DAYS,
      points: scoredPoints
    };

    // Save to cache
    cache.set(cacheKey, { timestamp: Date.now(), data });

    return res.status(200).json(data);
  } catch (err) {
    console.error('spray-map error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

module.exports = handler;
module.exports.generateGrid = generateGrid;
module.exports.buildForecastUrl = buildForecastUrl;
module.exports.FORECAST_DAYS = FORECAST_DAYS;
module.exports.HOURLY_DAYS = HOURLY_DAYS;
module.exports.HOURLY_LIMIT = HOURLY_LIMIT;
module.exports.FETCH_HOURS = FETCH_HOURS;
module.exports.CONFIDENT_DAYS = CONFIDENT_DAYS;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
module.exports.markLowerConfidence = markLowerConfidence;
module.exports.applyViewWindows = applyViewWindows;
module.exports.getCacheKey = getCacheKey;
module.exports.majorityDayStatus = majorityDayStatus;
module.exports.worstCaseStatus = worstCaseStatus;
module.exports.findBestWindow = findBestWindow;
module.exports.daytimeHours = daytimeHours;
module.exports.rollupDaily = rollupDaily;
module.exports.formatHourShort = formatHourShort;

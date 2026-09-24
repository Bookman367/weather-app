const {
  scoreHourly,
  normalizeOpenMeteo,
  futureHoursFromNow,
  PRODUCTS
} = require('../lib/spray-logic');

// Simple in-memory cache
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const cache = new Map();

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

    // Fetch 2 days of forecast to cover up to 48 hours
    const url = [
      `https://api.open-meteo.com/v1/forecast`,
      `?latitude=${lats}&longitude=${lons}`,
      `&hourly=${hourlyVars}`,
      `&daily=${dailyVars}`,
      `&forecast_days=2`,
      `&temperature_unit=fahrenheit`,
      `&wind_speed_unit=mph`,
      `&precipitation_unit=inch`,
      `&timezone=auto`
    ].join('');

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
      const norm = normalizeOpenMeteo(rawLocationData);

      // We only care about the next ~48 hours
      const futureHours = futureHoursFromNow(norm.hourly);

      // Score the hours
      const scoredHourly = scoreHourly(futureHours, product, 'clarity');

      // Map down to what the frontend needs to save bandwidth
      const simplifiedHourly = scoredHourly.map(h => ({
        time: h.time,
        status: h.spray.status,
        reasons: h.spray.reasons,
        temp: h.temp_f,
        wind: h.wind_mph,
        gust: h.gust_mph,
        rh: h.rh,
        precip: h.precip_pct
      }));

      return {
        ...p,
        hourly: simplifiedHourly
      };
    });

    const data = {
      center: { lat, lon },
      radius,
      product,
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

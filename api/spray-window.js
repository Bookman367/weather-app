// ============================================================
// GET /api/spray-window
// Public Ops surface over Hero's single spray engine.
// Weather keys stay server-side. Scores come only from
// lib/spray-logic.js (same functions the UI forecast uses).
// ============================================================

const {
  geocode,
  parseLatLon,
  firstQueryValue,
  loadScoredForecast,
  buildSprayWindowResponse
} = require('../lib/spray-logic');

// Until DroneSense Ops production origin is fixed, allow any GET origin.
const CORS_ORIGIN = '*';

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

async function resolveLocation(query) {
  const coords = parseLatLon(query);
  if (coords.ok) {
    return { lat: coords.lat, lon: coords.lon };
  }
  // Partial or out-of-range coords must 400 — do not fall back to zip.
  if (!coords.missing) {
    const err = new Error('Missing or invalid lat/lon');
    err.statusCode = 400;
    throw err;
  }

  const zip = firstQueryValue(query.zip);
  if (zip !== undefined && zip !== null && String(zip).trim() !== '') {
    const geo = await geocode(String(zip).trim());
    return { lat: geo.lat, lon: geo.lon };
  }

  const err = new Error('Missing or invalid lat/lon');
  err.statusCode = 400;
  throw err;
}

async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = req.query || {};

  let location;
  try {
    location = await resolveLocation(query);
  } catch (err) {
    if (err.statusCode === 400) {
      return badRequest(res, err.message || 'Missing or invalid lat/lon');
    }
    return badRequest(res, 'Unable to geocode zip');
  }

  const { lat, lon } = location;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return badRequest(res, 'lat/lon out of range');
  }

  try {
    const { hourly, utcOffsetSeconds } = await loadScoredForecast(lat, lon);
    if (!hourly || hourly.length === 0) {
      return res.status(502).json({ error: 'Upstream weather fetch failed' });
    }
    return res.status(200).json(buildSprayWindowResponse({
      lat,
      lon,
      hourly,
      utcOffsetSeconds
    }));
  } catch (err) {
    console.error('spray-window upstream error:', err);
    return res.status(502).json({ error: 'Upstream weather fetch failed' });
  }
}

module.exports = handler;

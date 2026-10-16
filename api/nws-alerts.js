// ============================================================
// GET /api/nws-alerts?lat=&lon=
// Tiny proxy so the browser can read NWS active alerts while
// sending the required User-Agent. Display only — does not score.
// ============================================================

const HeadsUp = require('../lib/heads-up');

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const cache = 'public, s-maxage=60, stale-while-revalidate=120';
  res.setHeader('Cache-Control', cache);
  res.setHeader('CDN-Cache-Control', cache);
  res.setHeader('Vercel-CDN-Cache-Control', cache);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function emptyOk(res) {
  return res.status(200).json({ ok: false, alerts: [] });
}

async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = req.query || {};
  const lat = firstValue(query.lat);
  const lon = firstValue(query.lon);
  const url = HeadsUp.nwsAlertsUrl(lat, lon);
  if (!url) {
    return res.status(400).json({ error: 'Missing or invalid lat/lon' });
  }

  try {
    const upstream = await fetch(url, { headers: HeadsUp.NWS_HEADERS });
    if (!upstream.ok) return emptyOk(res);
    const geojson = await upstream.json();
    const alerts = HeadsUp.summarizeAlerts(geojson);
    return res.status(200).json({ ok: true, alerts });
  } catch (err) {
    console.error('nws-alerts upstream error:', err);
    return emptyOk(res);
  }
}

module.exports = handler;

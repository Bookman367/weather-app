// ============================================================
// Heads up — NWS alerts + spray-window GO timing (display only)
//
// Active alerts: GET api.weather.gov/alerts/active?point=lat,lon
// NWS requires a User-Agent that identifies the app. Browsers cannot
// set that header, so the page calls /api/nws-alerts (tiny proxy).
//
// GO line: uses the already-scored hourly Spray Window. "GO" means
// spray.status === 'favorable' (the green blocks). Caution / no-good
// are not GO. "Soon" is within SOON_HOURS (2) on today's clock.
// Hourly.time is naive local for the field (`2026-10-16T13:00`).
// Do not run those strings through Date() — that uses the phone zone.
// Prefer hourly[0] as "now" so the line matches the bar on screen.
//
// Display only. Must not be fed into scoreSprayConditions.
//
// Works in Node (require) and the browser (global HeadsUp).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.HeadsUp = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SOON_HOURS = 2;
  const GO_STATUS = 'favorable';
  const MAX_ALERTS = 3;
  const LOCAL_HOUR = /^(\d{4}-\d{2}-\d{2})T(\d{2})/;
  const NWS_USER_AGENT = 'SprayWeatherApp/2.0 (agricultural spray forecast)';
  const NWS_HEADERS = {
    'User-Agent': NWS_USER_AGENT,
    Accept: 'application/geo+json'
  };
  const SEVERITY_RANK = {
    Extreme: 0,
    Severe: 1,
    Moderate: 2,
    Minor: 3,
    Unknown: 4
  };

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function parsePoint(lat, lon) {
    const la = finiteNumber(lat);
    const lo = finiteNumber(lon);
    if (la == null || lo == null || la < -90 || la > 90 || lo < -180 || lo > 180) {
      return null;
    }
    return { lat: Number(la.toFixed(4)), lon: Number(lo.toFixed(4)) };
  }

  function nwsAlertsUrl(lat, lon) {
    const point = parsePoint(lat, lon);
    if (!point) return null;
    return `https://api.weather.gov/alerts/active?point=${point.lat},${point.lon}`;
  }

  function proxyUrl(lat, lon) {
    const point = parsePoint(lat, lon);
    if (!point) return null;
    return `/api/nws-alerts?lat=${encodeURIComponent(String(point.lat))}&lon=${encodeURIComponent(String(point.lon))}`;
  }

  function parseNaiveHour(iso) {
    const m = String(iso || '').match(LOCAL_HOUR);
    if (!m) return null;
    return {
      date: m[1],
      hour: Number(m[2]),
      hourKey: `${m[1]}T${m[2]}:00`
    };
  }

  function nowLocalFromHourly(hourly) {
    if (!Array.isArray(hourly) || !hourly[0]) return null;
    const p = parseNaiveHour(hourly[0].time);
    return p ? p.hourKey : null;
  }

  function nowLocalFromInstant(date, { utcOffsetSeconds } = {}) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const offset = finiteNumber(utcOffsetSeconds);
    if (offset == null) return null;
    const shifted = new Date(date.getTime() + offset * 1000);
    const y = shifted.getUTCFullYear();
    const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    const h = String(shifted.getUTCHours()).padStart(2, '0');
    const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${y}-${mo}-${d}T${h}:${mi}`;
  }

  function formatClockHour(hour) {
    const n = finiteNumber(hour);
    if (n == null) return '';
    const h = ((Math.trunc(n) % 24) + 24) % 24;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12} ${ampm}`;
  }

  function isGo(hour) {
    return !!(hour && hour.spray && hour.spray.status === GO_STATUS);
  }

  function goSoonNote(hourly, nowLocal, { soonHours = SOON_HOURS } = {}) {
    const now = parseNaiveHour(nowLocal);
    if (!now || !Array.isArray(hourly) || hourly.length === 0) return null;
    const soon = finiteNumber(soonHours);
    if (soon == null || soon < 0) return null;

    const today = [];
    for (const hour of hourly) {
      const parts = parseNaiveHour(hour && hour.time);
      if (parts && parts.date === now.date) today.push({ hour, parts });
    }
    if (!today.length) return null;

    let idx = today.findIndex(row => row.parts.hour >= now.hour);
    if (idx < 0) return null;

    const current = today[idx];
    const currentIsNow = current.parts.hour === now.hour;

    if (currentIsNow && isGo(current.hour)) {
      let endIdx = idx;
      while (endIdx + 1 < today.length && isGo(today[endIdx + 1].hour)) endIdx += 1;
      const last = today[endIdx];
      const hoursUntilLast = last.parts.hour - now.hour;
      if (hoursUntilLast > soon) return null;
      const label = formatClockHour(last.parts.hour);
      if (hoursUntilLast === 0) {
        return `The GO spray window ends this hour (${label}).`;
      }
      return `The GO spray window ends around ${label} today.`;
    }

    const startFrom = currentIsNow ? idx + 1 : idx;
    let start = null;
    for (let i = startFrom; i < today.length; i += 1) {
      if (isGo(today[i].hour)) {
        start = today[i];
        break;
      }
    }
    if (!start) return null;
    const hoursUntil = start.parts.hour - now.hour;
    if (hoursUntil > 0 && hoursUntil <= soon) {
      return `A GO spray window starts around ${formatClockHour(start.parts.hour)} today.`;
    }
    return null;
  }

  function summarizeAlerts(geojson) {
    const features = geojson && Array.isArray(geojson.features) ? geojson.features : [];
    const rows = [];
    for (const feature of features) {
      const props = feature && feature.properties;
      if (!props) continue;
      const event = String(props.event || '').trim();
      if (!event) continue;
      const severity = String(props.severity || 'Unknown').trim() || 'Unknown';
      rows.push({
        id: String(props.id || feature.id || event),
        event,
        headline: String(props.headline || event).trim(),
        severity,
        urgency: String(props.urgency || '').trim(),
        ends: props.ends || props.expires || null,
        areaDesc: String(props.areaDesc || '').trim()
      });
    }
    rows.sort((a, b) => {
      const ra = SEVERITY_RANK[a.severity] ?? 9;
      const rb = SEVERITY_RANK[b.severity] ?? 9;
      if (ra !== rb) return ra - rb;
      return String(a.event).localeCompare(String(b.event));
    });
    return rows;
  }

  function emptyHeadsUp() {
    return { alerts: [], goNote: null, visible: false };
  }

  function buildHeadsUp({ alerts, hourly, nowLocal, soonHours } = {}) {
    const list = Array.isArray(alerts)
      ? alerts.filter(row => row && row.event)
      : summarizeAlerts(alerts);
    const goNote = goSoonNote(hourly, nowLocal, { soonHours });
    const shown = list.slice(0, MAX_ALERTS);
    return {
      alerts: shown,
      goNote,
      visible: shown.length > 0 || !!goNote
    };
  }

  return {
    SOON_HOURS,
    GO_STATUS,
    MAX_ALERTS,
    NWS_USER_AGENT,
    NWS_HEADERS,
    parsePoint,
    nwsAlertsUrl,
    proxyUrl,
    parseNaiveHour,
    nowLocalFromHourly,
    nowLocalFromInstant,
    formatClockHour,
    isGo,
    goSoonNote,
    summarizeAlerts,
    buildHeadsUp,
    emptyHeadsUp
  };
}));

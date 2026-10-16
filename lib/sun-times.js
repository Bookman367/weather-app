// ============================================================
// Sunrise / sunset display — Open-Meteo daily fields
//
// Open-Meteo `timezone=auto` already returns daily sunrise/sunset as
// local-to-the-spot wall-clock strings (no Z, no offset):
//   "2024-06-21T05:16"
// Those strings are the source of truth for display. Do not run them
// through Date() — a timezone-less ISO datetime is interpreted as the
// *runtime* local zone, which is the server or the farmer's phone, not
// the selected field. DST spring-forward also makes 2:00–3:00 invalid
// in Date(), which would shift a parsed hour.
//
// Scoring still uses calcSunriseSunset in spray-logic.js. This module
// is display-only: labels, day/night shading, sunrise/sunset markers.
//
// Works in Node (require) and the browser (global SunTimes).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.SunTimes = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

  function parseOpenMeteoLocal(iso) {
    if (iso == null) return null;
    const text = String(iso).trim();
    if (!text || text === 'N/A') return null;
    const m = text.match(LOCAL_ISO);
    if (!m) return null;
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] || 0),
      date: `${m[1]}-${m[2]}-${m[3]}`
    };
  }

  function minutesOfDay(parts) {
    if (!parts) return null;
    return parts.hour * 60 + parts.minute + (parts.second || 0) / 60;
  }

  function formatSunTime(iso) {
    const parts = parseOpenMeteoLocal(iso);
    if (!parts) return null;
    const ampm = parts.hour >= 12 ? 'PM' : 'AM';
    const hour12 = parts.hour % 12 || 12;
    const mm = String(parts.minute).padStart(2, '0');
    return `${hour12}:${mm} ${ampm}`;
  }

  function formatSunTimeShort(iso) {
    const parts = parseOpenMeteoLocal(iso);
    if (!parts) return null;
    const ampm = parts.hour >= 12 ? 'p' : 'a';
    const hour12 = parts.hour % 12 || 12;
    const mm = String(parts.minute).padStart(2, '0');
    return `${hour12}:${mm}${ampm}`;
  }

  function rangesOverlap(start, end, from, to) {
    return end > from && start < to;
  }

  // Hour [start, start+60) is daylight if it overlaps [sunrise, sunset).
  // A 7:00 block with sunrise at 7:12 is a daylight spraying hour (with a
  // sunrise marker), not a night hour. When sunset is earlier than sunrise
  // (polar wrap), daylight is [sunrise, 24:00) ∪ [00:00, sunset).
  function isDaylight(hourIso, sunriseIso, sunsetIso) {
    const hour = parseOpenMeteoLocal(hourIso);
    const rise = parseOpenMeteoLocal(sunriseIso);
    const set = parseOpenMeteoLocal(sunsetIso);
    if (!hour || !rise || !set) return null;
    const start = minutesOfDay(hour);
    const end = start + 60;
    const a = minutesOfDay(rise);
    const b = minutesOfDay(set);
    if (a === b) return null;
    if (a < b) return rangesOverlap(start, end, a, b);
    return rangesOverlap(start, end, a, 1440) || rangesOverlap(start, end, 0, b);
  }

  function hourContains(hourIso, eventIso) {
    const hour = parseOpenMeteoLocal(hourIso);
    const event = parseOpenMeteoLocal(eventIso);
    if (!hour || !event) return false;
    if (hour.date !== event.date) return false;
    const start = minutesOfDay(hour);
    const at = minutesOfDay(event);
    return at >= start && at < start + 60;
  }

  function sunEventForHour(hourIso, sunriseIso, sunsetIso) {
    if (hourContains(hourIso, sunriseIso)) return 'sunrise';
    if (hourContains(hourIso, sunsetIso)) return 'sunset';
    return null;
  }

  function classifyHourSun(hourIso, sunriseIso, sunsetIso) {
    return {
      daylight: isDaylight(hourIso, sunriseIso, sunsetIso),
      sunEvent: sunEventForHour(hourIso, sunriseIso, sunsetIso)
    };
  }

  function indexDailySun(daily) {
    const byDate = Object.create(null);
    for (const row of daily || []) {
      if (!row || typeof row !== 'object') continue;
      const date = String(row.date || row.time || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      byDate[date] = {
        sunrise: parseOpenMeteoLocal(row.sunrise) ? row.sunrise : null,
        sunset: parseOpenMeteoLocal(row.sunset) ? row.sunset : null,
        windDir: row.wind_dir != null ? row.wind_dir : (row.windDir || null),
        windDirDeg: row.wind_dir_deg != null ? row.wind_dir_deg : row.windDirDeg
      };
    }
    return byDate;
  }

  function sunForDate(sunByDate, dateOrTime) {
    if (!sunByDate || typeof sunByDate !== 'object') return null;
    const date = String(dateOrTime || '').slice(0, 10);
    return sunByDate[date] || null;
  }

  return {
    parseOpenMeteoLocal,
    minutesOfDay,
    formatSunTime,
    formatSunTimeShort,
    isDaylight,
    sunEventForHour,
    classifyHourSun,
    indexDailySun,
    sunForDate
  };
}));

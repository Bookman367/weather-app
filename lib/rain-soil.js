// ============================================================
// Recent rain and soil — display only
//
// Open-Meteo Forecast API with past_days=7, timezone=auto:
//   daily  precipitation_sum          (inches; precipitation_unit=inch)
//   hourly soil_moisture_0_to_1cm     (m³/m³ volumetric water content)
//   hourly soil_temperature_6cm       (°F when temperature_unit=fahrenheit)
//
// Hourly.time / daily.time are naive local for the selected spot
// (`2026-10-16T13:00`). Do not run those strings through Date() — that
// uses the phone or server zone, not the field. Compare them as
// wall-clock strings, the same way futureHoursFromNow does.
//
// Today's daily precipitation_sum is a full-day total (rain already
// fallen plus the rest of today's forecast). Last-24h uses hourly
// precipitation so it is a trailing window ending at the current
// local hour, not the rest of today's forecast.
//
// Soil moisture labels (0–1 cm VWC, generic — not texture-specific):
//   dry   <  0.15 m³/m³
//   moist >= 0.15 and < 0.30 m³/m³
//   wet   >= 0.30 m³/m³
//
// Display only. Must not be fed into scoreSprayConditions or change
// any go / caution / no-go threshold.
//
// Works in Node (require) and the browser (global RainSoil).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.RainSoil = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PAST_DAYS = 7;
  const RAIN_DAY_IN = 0.1;

  // Volumetric water content (m³/m³) at 0–1 cm.
  const MOISTURE_DRY_MAX = 0.15;
  const MOISTURE_WET_MIN = 0.30;

  const LOCAL_HOUR = /^(\d{4}-\d{2}-\d{2})T(\d{2})/;
  const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function roundTo(value, digits) {
    const n = finiteNumber(value);
    if (n == null) return null;
    const f = Math.pow(10, digits);
    return Math.round(n * f) / f;
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

  function parseYmd(ymd) {
    const m = String(ymd || '').match(YMD);
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), date: `${m[1]}-${m[2]}-${m[3]}` };
  }

  // Civil-date math in UTC so process TZ cannot shift the calendar day.
  function addDaysYmd(ymd, days) {
    const parts = parseYmd(ymd);
    if (!parts) return null;
    const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  function naiveHourKey(iso) {
    const p = parseNaiveHour(iso);
    return p ? p.hourKey : '';
  }

  function moistureLabel(vwc) {
    const n = finiteNumber(vwc);
    if (n == null) return null;
    if (n < MOISTURE_DRY_MAX) return 'dry';
    if (n >= MOISTURE_WET_MIN) return 'wet';
    return 'moist';
  }

  function emptySummary() {
    return {
      available: false,
      rain_24h_in: null,
      rain_3d_in: null,
      rain_7d_in: null,
      days_since_rain: null,
      soil_temp_f: null,
      soil_moisture: null,
      soil_moisture_label: null,
      spray_note: 'Recent rain and soil is not available for this location.'
    };
  }

  function sprayNote(row) {
    const r24 = row.rain_24h_in;
    const r3 = row.rain_3d_in;
    const days = row.days_since_rain;
    const moist = row.soil_moisture_label;

    if (r24 != null && r24 > RAIN_DAY_IN) {
      return 'Recent rain — wait until foliage is dry before spraying.';
    }
    if (days === 0) {
      return 'Rain today — wait until foliage is dry before spraying.';
    }
    if ((r3 != null && r3 > 0.5) || moist === 'wet') {
      return 'Ground is still wet from recent rain — check field access and that plants are dry.';
    }
    if (days != null && days <= 2) {
      return 'Rain in the last couple of days — confirm plants are dry before spraying.';
    }
    return 'No meaningful recent rain — usual rain-timing lookback is clear.';
  }

  function zipDailyPrecip(raw) {
    const d = raw && raw.daily;
    if (!d || !Array.isArray(d.time)) return [];
    const sums = d.precipitation_sum || [];
    const rows = [];
    for (let i = 0; i < d.time.length; i++) {
      const date = String(d.time[i] || '').slice(0, 10);
      if (!YMD.test(date)) continue;
      rows.push({ date, precip_in: finiteNumber(sums[i]) });
    }
    return rows;
  }

  function zipHourly(raw) {
    const h = raw && raw.hourly;
    if (!h || !Array.isArray(h.time)) return [];
    const precip = h.precipitation || [];
    const moist = h.soil_moisture_0_to_1cm || [];
    const temp = h.soil_temperature_6cm || [];
    const rows = [];
    for (let i = 0; i < h.time.length; i++) {
      const parsed = parseNaiveHour(h.time[i]);
      if (!parsed) continue;
      rows.push({
        time: h.time[i],
        hourKey: parsed.hourKey,
        date: parsed.date,
        precip_in: finiteNumber(precip[i]),
        soil_moisture: finiteNumber(moist[i]),
        soil_temp_f: finiteNumber(temp[i])
      });
    }
    return rows;
  }

  function sumDailyWindow(dailyRows, fromDate, toDate) {
    let sum = 0;
    let any = false;
    for (const row of dailyRows) {
      if (row.date >= fromDate && row.date <= toDate) {
        if (row.precip_in != null) {
          sum += row.precip_in;
          any = true;
        }
      }
    }
    return any ? sum : null;
  }

  function trailing24hPrecip(hourlyRows, nowHourKey) {
    const now = parseNaiveHour(nowHourKey);
    if (!now) return null;
    const startDate = addDaysYmd(now.date, -1);
    const startKey = `${startDate}T${String(now.hour).padStart(2, '0')}:00`;
    let sum = 0;
    let any = false;
    for (const row of hourlyRows) {
      if (row.hourKey > startKey && row.hourKey <= now.hourKey) {
        if (row.precip_in != null) {
          sum += row.precip_in;
          any = true;
        }
      }
    }
    return any ? sum : null;
  }

  function daysSinceRainOver(dailyRows, today, thresholdIn) {
    const byDate = Object.create(null);
    for (const row of dailyRows) {
      if (row.precip_in != null) byDate[row.date] = row.precip_in;
    }
    for (let days = 0; days <= PAST_DAYS; days++) {
      const date = addDaysYmd(today, -days);
      if (!date) return null;
      if (!Object.prototype.hasOwnProperty.call(byDate, date)) {
        if (days === 0) continue;
        return null;
      }
      if (byDate[date] > thresholdIn) return days;
    }
    return null;
  }

  function currentSoil(hourlyRows, nowHourKey) {
    let best = null;
    for (const row of hourlyRows) {
      if (row.hourKey > nowHourKey) continue;
      if (!best || row.hourKey > best.hourKey) best = row;
      if (row.hourKey === nowHourKey) break;
    }
    if (!best) return { soil_temp_f: null, soil_moisture: null, soil_moisture_label: null };
    return {
      soil_temp_f: best.soil_temp_f == null ? null : Math.round(best.soil_temp_f),
      soil_moisture: roundTo(best.soil_moisture, 3),
      soil_moisture_label: moistureLabel(best.soil_moisture)
    };
  }

  function sliceParallel(block, startIndex) {
    if (!block || typeof block !== 'object') return block;
    const out = {};
    for (const key of Object.keys(block)) {
      const val = block[key];
      out[key] = Array.isArray(val) ? val.slice(startIndex) : val;
    }
    return out;
  }

  // Drop past_days rows so normalizeOpenMeteo still sees "today 00:00"
  // as the first hour — same 96-hour window as before this card.
  function forecastWindow(raw, nowLocal) {
    if (!raw || typeof raw !== 'object') return raw;
    const now = parseNaiveHour(nowLocal);
    if (!now) return raw;

    const hourly = raw.hourly;
    let hourlyStart = 0;
    if (hourly && Array.isArray(hourly.time)) {
      const idx = hourly.time.findIndex(t => naiveHourKey(t) >= `${now.date}T00:00`);
      hourlyStart = idx < 0 ? hourly.time.length : idx;
    }

    const daily = raw.daily;
    let dailyStart = 0;
    if (daily && Array.isArray(daily.time)) {
      const idx = daily.time.findIndex(t => String(t || '').slice(0, 10) >= now.date);
      dailyStart = idx < 0 ? daily.time.length : idx;
    }

    return Object.assign({}, raw, {
      hourly: sliceParallel(hourly, hourlyStart),
      daily: sliceParallel(daily, dailyStart)
    });
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatNaiveLocal(parts) {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  }

  // Instant → naive local string in the field's zone. Same rule as
  // nowInSpotTimezone: prefer IANA timezone, else utc_offset_seconds.
  function nowLocalFromInstant(now, tzInfo) {
    const date = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    const opts = tzInfo || {};
    if (opts.timezone) {
      try {
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: opts.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          hourCycle: 'h23'
        });
        const map = {};
        for (const part of fmt.formatToParts(date)) {
          if (part.type !== 'literal') map[part.type] = part.value;
        }
        let hour = Number(map.hour);
        if (hour === 24) hour = 0;
        return formatNaiveLocal({
          year: Number(map.year),
          month: Number(map.month),
          day: Number(map.day),
          hour,
          minute: Number(map.minute),
          second: Number(map.second)
        });
      } catch {
        // fall through to offset
      }
    }
    const shifted = new Date(date.getTime() + (opts.utcOffsetSeconds || 0) * 1000);
    return formatNaiveLocal({
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds()
    });
  }

  function openMeteoPastDaysUrl(lat, lon, pastDays) {
    const days = pastDays == null
      ? PAST_DAYS
      : Math.min(92, Math.max(0, Math.round(Number(pastDays) || 0)));
    return [
      'https://api.open-meteo.com/v1/forecast',
      `?latitude=${lat}&longitude=${lon}`,
      '&hourly=precipitation,soil_moisture_0_to_1cm,soil_temperature_6cm',
      '&daily=precipitation_sum',
      '&forecast_days=1',
      `&past_days=${days}`,
      '&temperature_unit=fahrenheit',
      '&precipitation_unit=inch',
      '&timezone=auto'
    ].join('');
  }

  function summarizeFromOpenMeteo(raw, nowLocal) {
    const now = parseNaiveHour(nowLocal);
    if (!now || !raw || typeof raw !== 'object') return emptySummary();

    const dailyRows = zipDailyPrecip(raw);
    const hourlyRows = zipHourly(raw);
    if (dailyRows.length === 0 && hourlyRows.length === 0) return emptySummary();

    const from3 = addDaysYmd(now.date, -2);
    const from7 = addDaysYmd(now.date, -6);
    const soil = currentSoil(hourlyRows, now.hourKey);

    const row = {
      available: true,
      rain_24h_in: roundTo(trailing24hPrecip(hourlyRows, now.hourKey), 2),
      rain_3d_in: roundTo(sumDailyWindow(dailyRows, from3, now.date), 2),
      rain_7d_in: roundTo(sumDailyWindow(dailyRows, from7, now.date), 2),
      days_since_rain: daysSinceRainOver(dailyRows, now.date, RAIN_DAY_IN),
      soil_temp_f: soil.soil_temp_f,
      soil_moisture: soil.soil_moisture,
      soil_moisture_label: soil.soil_moisture_label,
      spray_note: ''
    };
    row.spray_note = sprayNote(row);
    return row;
  }

  return {
    PAST_DAYS,
    RAIN_DAY_IN,
    MOISTURE_DRY_MAX,
    MOISTURE_WET_MIN,
    finiteNumber,
    parseNaiveHour,
    addDaysYmd,
    moistureLabel,
    sprayNote,
    emptySummary,
    forecastWindow,
    nowLocalFromInstant,
    openMeteoPastDaysUrl,
    summarizeFromOpenMeteo
  };
}));

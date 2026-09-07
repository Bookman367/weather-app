// ============================================================
// Spray Weather Forecast API — Vercel Serverless Handler
// Scoring and weather fetch live in lib/spray-logic.js so the
// UI (/api/forecast) and Ops (/api/spray-window) cannot drift.
// ============================================================

const {
  PRODUCTS,
  scoreSprayConditions,
  calcDeltaT,
  deltaTtoF,
  calcSunriseSunset,
  hoursUntilRain,
  geocode,
  fetchWeather,
  fetchWeatherNWS,
  normalizeOpenMeteo,
  normalizeNWS,
  normalizeCondition,
  parseLatLon
} = require('../lib/spray-logic');

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let locationStr, herbicide, method, source, sunriseOffset, sunsetOffset, coordQuery;
  if (req.method === 'GET') {
    const { query } = req;
    coordQuery = query;
    locationStr = query.q || '';
    herbicide   = query.herbicide || 'general';
    method      = query.method || 'clarity';
    source      = query.source || 'open-meteo';
    sunriseOffset = parseInt(query.sunriseOffset || '0');
    sunsetOffset  = parseInt(query.sunsetOffset || '2');
  } else {
    const body = req.body || {};
    coordQuery = body;
    locationStr = body.q || '';
    herbicide   = body.herbicide || 'general';
    method      = body.method || 'clarity';
    source      = body.source || 'open-meteo';
    sunriseOffset = parseInt(body.sunriseOffset || '0');
    sunsetOffset  = parseInt(body.sunsetOffset || '2');
  }

  try {
    // Honor explicit lat/lon when present. Legacy callers that omit both
    // q and coords still default to 68508 (Lincoln NE) for UI compatibility.
    const coords = parseLatLon(coordQuery);
    let geoResult;
    if (coords.ok) {
      geoResult = { lat: coords.lat, lon: coords.lon, display: `${coords.lat},${coords.lon}` };
    } else {
      if (!locationStr) locationStr = '68508';
      geoResult = await geocode(locationStr);
    }
    let raw, tzOffset;

    // Fetch from selected weather source
    switch (source) {
      case 'nws':
        const nwsRaw = await fetchWeatherNWS(geoResult.lat, geoResult.lon);
        const nwsNorm = normalizeNWS(nwsRaw);
        var hourly = nwsNorm.hourly;
        var daily = nwsNorm.daily;
        var timezone = nwsNorm.timezone;
        break;
      default:
        raw = await fetchWeather(geoResult.lat, geoResult.lon);
        const norm = normalizeOpenMeteo(raw);
        var hourly = norm.hourly;
        var daily = norm.daily;
        var timezone = norm.timezone;
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
    function parseSunHour(sunStr) {
      if (!sunStr || typeof sunStr !== 'string') return null;
      const m = sunStr.match(/(\d+):(\d+)\s+(AM|PM)/);
      if (!m) return null;
      let h = parseInt(m[1]);
      if (m[3] === 'PM' && h !== 12) h += 12;
      if (m[3] === 'AM' && h === 12) h = 0;
      return h + parseInt(m[2]) / 60;
    }

    // ── Sprayable daytime window helper ────────────────────────────────
    // JD sprays sunrise → sunset+offset. Returns hours from dayHours within that window.
    function daytimeHours(dayHours, sunriseStr, sunsetStr, sunriseOffset, sunsetOffset) {
      if (!sunriseStr || !sunsetStr || sunriseStr === 'N/A' || sunsetStr === 'N/A') return dayHours;
      const sunriseH = parseSunHour(sunriseStr);
      const rawSunsetH = parseSunHour(sunsetStr);
      if (sunriseH === null || rawSunsetH === null) return dayHours;

      const startSprayH = (sunriseH + sunriseOffset + 24) % 24;
      const endSprayH = (rawSunsetH + sunsetOffset + 24) % 24;

      return dayHours.filter(h => {
        // h.time is stored as an ISO UTC string from both NWS and Open-Meteo.
        const d = new Date(h.time);
        const hour = d.getHours() + d.getMinutes() / 60;
        if (startSprayH < endSprayH) {
          return hour >= startSprayH && hour <= endSprayH;
        } else {
          // Window crosses midnight
          return hour >= startSprayH || hour <= endSprayH;
        }
      });
    }

    // ── Majority-rule daily status ────────────────────────────────────
    // "What the majority of hours show = what the day shows"
    function majorityDayStatus(daySprayHours) {
      if (daySprayHours.length === 0) return 'favorable';
      const counts = { favorable: 0, caution: 0, 'no-good': 0 };
      for (const h of daySprayHours) counts[h.spray.status]++;
      if (counts['no-good'] > counts.favorable && counts['no-good'] > counts.caution) return 'no-good';
      if (counts.caution > counts.favorable && counts.caution > counts['no-good']) return 'caution';
      if (counts.favorable === counts['no-good'] && counts.favorable > counts.caution) return 'caution';
      if (counts.caution === counts['no-good'] && counts.caution > counts.favorable) return 'no-good';
      return 'favorable';
    }

    // ── Process daily (7 days) ────────────────────────────
    // Merge spray scores into source daily rows. Never append duplicate
    // dates — the UI crashes on source-only rows that lack day.spray.
    function finiteMax(values) {
      const nums = values.filter(v => v != null && Number.isFinite(Number(v))).map(Number);
      return nums.length ? Math.max(...nums) : null;
    }
    function finiteMin(values) {
      const nums = values.filter(v => v != null && Number.isFinite(Number(v))).map(Number);
      return nums.length ? Math.min(...nums) : null;
    }

    const sourceByDate = new Map();
    for (const day of daily) {
      if (!day || !day.date) continue;
      const incoming = {
        ...day,
        condition: normalizeCondition(day.condition)
      };
      const existing = sourceByDate.get(day.date);
      if (!existing) {
        sourceByDate.set(day.date, incoming);
        continue;
      }
      existing.temp_max_f = finiteMax([existing.temp_max_f, incoming.temp_max_f]);
      existing.temp_min_f = finiteMin([existing.temp_min_f, incoming.temp_min_f]);
      existing.wind_max_mph = finiteMax([existing.wind_max_mph, incoming.wind_max_mph]);
      existing.gust_max_mph = finiteMax([existing.gust_max_mph, incoming.gust_max_mph]);
      if ((!existing.condition || !existing.condition.desc) && incoming.condition && incoming.condition.desc) {
        existing.condition = incoming.condition;
      }
      if ((!existing.sunrise || existing.sunrise === 'N/A') && incoming.sunrise && incoming.sunrise !== 'N/A') {
        existing.sunrise = incoming.sunrise;
      }
      if ((!existing.sunset || existing.sunset === 'N/A') && incoming.sunset && incoming.sunset !== 'N/A') {
        existing.sunset = incoming.sunset;
      }
      if (existing.wind_dir_deg == null && incoming.wind_dir_deg != null) {
        existing.wind_dir_deg = incoming.wind_dir_deg;
        existing.wind_dir = incoming.wind_dir;
      }
    }

    const dayMap = new Map();
    for (const h of hourlyFinal) {
      const dateStr = h.time.split('T')[0];
      if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
      dayMap.get(dateStr).push(h);
    }

    const sprayByDate = new Map();
    for (const [dateStr, dayHours] of dayMap.entries()) {
      const maxF = finiteMax(dayHours.map(h => h.temp_f));
      const minF = finiteMin(dayHours.map(h => h.temp_f));
      const avgRH = Math.round(dayHours.reduce((s, h) => s + (h.rh || 0), 0) / dayHours.length);
      const sunTimes = calcSunriseSunset(geoResult.lat, geoResult.lon, dateStr, tzOffset || -21600);

      // Filter to daytime sprayable window
      const daySprayHours = daytimeHours(dayHours, sunTimes.sunrise, sunTimes.sunset, sunriseOffset, sunsetOffset);

      // Score using daytime window hours (if none, fall back to all hours)
      const scoringHours = daySprayHours.length > 0 ? daySprayHours : dayHours;

      // Use actual worst-case values for key thresholds from daytime window
      const maxWind = finiteMax(scoringHours.map(h => h.wind_mph));
      const maxGust = finiteMax(scoringHours.map(h => h.gust_mph));
      const maxPrecip = finiteMax(scoringHours.map(h => h.precip_pct));
      const worstDeltaT = scoringHours.reduce((worst, h) => {
        return h.delta_t > worst ? h.delta_t : worst;
      }, 0);
      const avgTemp = (maxF != null && minF != null) ? (maxF + minF) / 2 : (maxF ?? minF ?? 0);
      const deltaT = calcDeltaT((avgTemp - 32) * 5 / 9, avgRH);

      const sprayObj = scoreSprayConditions({
        temp_f: avgTemp,
        wind_mph: maxWind ?? 0,
        gust_mph: maxGust,
        rh: avgRH,
        precip_pct: maxPrecip ?? 0,
        delta_t: worstDeltaT,
        delta_t_f: deltaTtoF(worstDeltaT)
      }, herbicide, method);

      // Majority-rule daily status
      const overallStatus = majorityDayStatus(scoringHours);

      const allReasons = daySprayHours
        .flatMap(h => h.spray.reasons)
        .filter((r, i, a) => a.indexOf(r) === i); // dedupe

      // Hourly-derived sky when source daily has none
      const skyHour = scoringHours.find(h => h.condition && (h.condition.desc || h.condition.icon))
        || dayHours.find(h => h.condition && (h.condition.desc || h.condition.icon));

      sprayByDate.set(dateStr, {
        date: dateStr,
        temp_max_f: maxF,
        temp_min_f: minF,
        wind_max_mph: maxWind,
        gust_max_mph: maxGust,
        avg_rh: avgRH,
        precip_pct: maxPrecip ?? 0,
        condition: skyHour ? normalizeCondition(skyHour.condition) : { desc: null, icon: null },
        sunrise: sunTimes.sunrise,
        sunset: sunTimes.sunset,
        spray: {
          status: overallStatus,
          reasons: allReasons,
          product: sprayObj.product
        }
      });
    }

    const allDates = [...new Set([...sourceByDate.keys(), ...sprayByDate.keys()])].sort();
    daily = allDates.slice(0, 7).map(dateStr => {
      const src = sourceByDate.get(dateStr) || {};
      const scored = sprayByDate.get(dateStr) || {};
      return {
        date: dateStr,
        temp_max_f: src.temp_max_f ?? scored.temp_max_f,
        temp_min_f: src.temp_min_f ?? scored.temp_min_f,
        wind_max_mph: finiteMax([src.wind_max_mph, scored.wind_max_mph]),
        gust_max_mph: finiteMax([src.gust_max_mph, scored.gust_max_mph]),
        avg_rh: scored.avg_rh ?? src.avg_rh,
        precip_pct: scored.precip_pct ?? src.precip_pct ?? 0,
        wind_dir_deg: src.wind_dir_deg ?? scored.wind_dir_deg ?? null,
        wind_dir: src.wind_dir ?? scored.wind_dir ?? null,
        weather_code: src.weather_code ?? scored.weather_code,
        condition: (src.condition && src.condition.desc) ? src.condition : (scored.condition || { desc: null, icon: null }),
        sunrise: (src.sunrise && src.sunrise !== 'N/A') ? src.sunrise : scored.sunrise,
        sunset: (src.sunset && src.sunset !== 'N/A') ? src.sunset : scored.sunset,
        soil_temp_f: src.soil_temp_f ?? scored.soil_temp_f ?? null,
        spray: scored.spray || {
          status: 'favorable',
          reasons: [],
          product: product.name
        }
      };
    });

    // ── Summary stats ─────────────────────────────────────
    const favorableCount = hourlyFinal.filter(h => h.spray.status === 'favorable').length;
    const cautionCount   = hourlyFinal.filter(h => h.spray.status === 'caution').length;
    const noGoodCount    = hourlyFinal.filter(h => h.spray.status === 'no-good').length;

    let bestStart = null, bestLen = 0, curStart = null, curLen = 0;
    for (const h of hourlyFinal) {
      if (h.spray.status === 'favorable') {
        if (curStart === null) curStart = h.time;
        curLen++;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else { curStart = null; curLen = 0; }
    }

    return res.status(200).json({
      location: {
        lat: geoResult.lat,
        lon: geoResult.lon,
        display: geoResult.display
      },
      product: product.name,
      inversion: inversionAlert,
      rain_in_hours: rainIn,
      summary: { favorable: favorableCount, caution: cautionCount, no_good: noGoodCount, best_window: { start: bestStart, hours: bestLen } },
      hourly: hourlyFinal,
      daily
    });

  } catch (err) {
    console.error('Forecast error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

module.exports = handler;

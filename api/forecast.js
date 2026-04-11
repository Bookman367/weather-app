// ============================================================
// Spray Weather Forecast API — Vercel Serverless Handler
// Calls Open-Meteo (free, no key) + Nominatim geocoder
// Returns full hourly (96h) + daily (7d) structured JSON
// with spray status computed per product label thresholds
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
function scoreSprayConditions(hour, product) {
  const p = PRODUCTS[product] || PRODUCTS.general;
  const reasons = [];
  let noGood = false;
  let cautionFlags = 0;

  const wind    = hour.wind_mph   || 0;
  const gust    = hour.gust_mph   || wind * 1.3;
  const temp    = hour.temp_f     || 70;
  const rh      = hour.rh         || 60;
  const precip  = hour.precip_pct || 0;
  const deltaT  = hour.delta_t    || 5;
  const isInv   = hour.inversion  || false;

  // Hard NO-GOOD triggers
  if (wind > p.max_wind_mph)  { noGood = true; reasons.push(`Wind ${wind.toFixed(0)} mph > max ${p.max_wind_mph} mph`); }
  if (gust > p.max_gust_mph)  { noGood = true; reasons.push(`Gusts ${gust.toFixed(0)} mph > max ${p.max_gust_mph} mph`); }
  if (temp < p.min_temp_f)    { noGood = true; reasons.push(`Temp ${temp.toFixed(0)}°F below min ${p.min_temp_f}°F`); }
  if (temp > p.max_temp_f)    { noGood = true; reasons.push(`Temp ${temp.toFixed(0)}°F above max ${p.max_temp_f}°F`); }
  if (precip >= 50)            { noGood = true; reasons.push(`Precip ${precip}% — rain likely`); }
  if (p.avoid_inversion && isInv) { noGood = true; reasons.push("Temperature inversion detected"); }

  // CAUTION triggers (only evaluated when not already no-good)
  if (!noGood) {
    if (wind > p.max_wind_mph * 0.75)        { cautionFlags++; reasons.push(`Wind ${wind.toFixed(0)} mph approaching limit`); }
    if (gust > p.max_gust_mph * 0.8)         { cautionFlags++; reasons.push(`Gusts ${gust.toFixed(0)} mph — near limit`); }
    if (precip >= p.max_precip_pct)           { cautionFlags++; reasons.push(`Precip ${precip}% — above label threshold`); }
    else if (precip >= p.max_precip_pct*0.6) { cautionFlags++; reasons.push(`Precip ${precip}% — moderate risk`); }
    if (rh < p.min_rh)                        { cautionFlags++; reasons.push(`RH ${rh}% below min ${p.min_rh}%`); }
    else if (rh < p.min_rh * 1.15)           { cautionFlags++; reasons.push(`RH ${rh}% near minimum`); }
    if (rh > p.max_rh)                        { cautionFlags++; reasons.push(`RH ${rh}% above max — absorption risk`); }
    if (deltaT < p.min_delta_t)               { cautionFlags++; reasons.push(`Delta-T ${deltaT.toFixed(1)}°C (${deltaTtoF(deltaT).toFixed(1)}°F spread) — inversion risk`); }
    if (deltaT > p.max_delta_t)               { cautionFlags++; reasons.push(`Delta-T ${deltaT.toFixed(1)}°C (${deltaTtoF(deltaT).toFixed(1)}°F spread) — evaporation risk`); }
    if (temp > p.max_temp_f * 0.92)           { cautionFlags++; reasons.push(`Temp ${temp.toFixed(0)}°F — near upper limit`); }
  }

  const status = noGood ? 'no-good' : cautionFlags >= 1 ? 'caution' : 'favorable';
  return { status, reasons, product: p.name };
}

// ── Delta-T: °C (ag standard) and °F equivalent ─────────────
// Delta-T = dry bulb - wet bulb (always in °C by ag convention)
// Optimal spraying: 2–8°C. <2 = inversion risk, >8 = evaporation
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
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
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
    'wind_direction_10m'
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

// ── Main Handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let locationStr, herbicide;
  if (req.method === 'GET') {
    locationStr = req.query.location || '';
    herbicide   = req.query.herbicide || 'general';
  } else {
    const body  = req.body || {};
    locationStr = body.location || '';
    herbicide   = body.herbicide || 'general';
  }
  if (!locationStr) return res.status(400).json({ error: 'Missing location parameter' });

  try {
    const geoResult = await geocode(locationStr);
    const raw       = await fetchWeather(geoResult.lat, geoResult.lon);
    const tzOffset  = raw.utc_offset_seconds || 0;
    const product   = PRODUCTS[herbicide] || PRODUCTS.general;

    // ── Process hourly (96h) ──────────────────────────────
    const h = raw.hourly;
    const hourCount = Math.min(h.time.length, 96);
    const hourly = [];

    for (let i = 0; i < hourCount; i++) {
      const tempF    = h.temperature_2m[i];
      const feelsF   = h.apparent_temperature[i];       // from API directly
      const dewF     = h.dew_point_2m[i];
      const tempC    = (tempF - 32) * 5 / 9;
      const rh       = h.relative_humidity_2m[i];
      const deltaT   = calcDeltaT(tempC, rh);           // always °C (ag standard)
      const deltaTF  = deltaTtoF(deltaT);               // °F spread for display
      const windMph  = h.wind_speed_10m[i];
      const gustMph  = h.wind_gusts_10m[i];
      const windDir  = h.wind_direction_10m[i];
      const precipPct= h.precipitation_probability[i] || 0;
      const precipIn = h.precipitation[i] || 0;
      const cloudPct = h.cloud_cover[i] || 0;
      const wmoCode  = h.weather_code[i] || 0;
      const inversion = deltaT < 2 && windMph < 5;

      const hourData = {
        time:          h.time[i],
        temp_f:        Math.round(tempF  * 10) / 10,
        feels_like_f:  Math.round(feelsF * 10) / 10,
        dew_f:         Math.round(dewF   * 10) / 10,
        rh:            Math.round(rh),
        delta_t:       Math.round(deltaT * 10) / 10,   // °C — ag standard
        delta_t_f:     Math.round(deltaTF * 10) / 10,  // °F spread — display
        wind_mph:      Math.round(windMph  * 10) / 10,
        gust_mph:      Math.round(gustMph  * 10) / 10,
        wind_dir_deg:  windDir,
        wind_dir:      degToCardinal(windDir),
        precip_pct:    Math.round(precipPct),
        precip_in:     Math.round(precipIn * 100) / 100,  // rounded to hundredths
        cloud_pct:     Math.round(cloudPct),
        weather_code:  wmoCode,
        condition:     wmoToCondition(wmoCode),
        inversion
      };
      hourData.spray = scoreSprayConditions(hourData, herbicide);
      hourly.push(hourData);
    }

    // ── Hours until rain ─────────────────────────────────
    const rainIn = hoursUntilRain(hourly, 30);

    // ── Active inversion alert ────────────────────────────
    const inversionNow = hourly[0]?.inversion || false;
    const inversionAlert = inversionNow ? {
      active: true,
      delta_t:   hourly[0].delta_t,
      delta_t_f: hourly[0].delta_t_f,
      wind_mph:  hourly[0].wind_mph,
      message:   `Temperature inversion conditions detected. Delta-T ${hourly[0].delta_t}°C (${hourly[0].delta_t_f}°F spread) with winds at ${hourly[0].wind_mph} mph. Spray droplets may pool and drift unpredictably. Do not apply.`
    } : { active: false };

    // ── Process daily (7 days) ────────────────────────────
    const d = raw.daily;
    const daily = [];

    for (let i = 0; i < d.time.length; i++) {
      const maxF      = d.temperature_2m_max[i];
      const minF      = d.temperature_2m_min[i];
      const feelsMax  = d.apparent_temperature_max[i];
      const feelsMin  = d.apparent_temperature_min[i];
      const precipSum = d.precipitation_sum[i] || 0;
      const precipPct = d.precipitation_probability_max[i] || 0;
      const windMax   = d.wind_speed_10m_max[i] || 0;
      const gustMax   = d.wind_gusts_10m_max[i] || 0;
      const windDirD  = d.wind_direction_10m_dominant[i];
      const wmoCode   = d.weather_code[i] || 0;

      // Task 7: use real avg RH from actual hourly data for this calendar date
      const dateStr = d.time[i];
      const dayHours = hourly.filter(h => h.time.startsWith(dateStr));
      const avgRH = dayHours.length
        ? Math.round(dayHours.reduce((s, h) => s + h.rh, 0) / dayHours.length)
        : 60;
      const avgWind = dayHours.length
        ? dayHours.reduce((s, h) => s + h.wind_mph, 0) / dayHours.length
        : windMax * 0.65;

      const avgTemp = (maxF + minF) / 2;
      const dailyHour = {
        temp_f:     avgTemp,
        wind_mph:   avgWind,
        gust_mph:   gustMax,
        rh:         avgRH,
        precip_pct: precipPct,
        delta_t:    calcDeltaT((avgTemp - 32) * 5 / 9, avgRH),
        delta_t_f:  deltaTtoF(calcDeltaT((avgTemp - 32) * 5 / 9, avgRH)),
        inversion:  false
      };

      // Sunrise/sunset (astronomical calc, no extra API call)
      const sunTimes = calcSunriseSunset(geoResult.lat, geoResult.lon, dateStr, tzOffset);

      daily.push({
        date:           dateStr,
        temp_max_f:     Math.round(maxF    * 10) / 10,
        temp_min_f:     Math.round(minF    * 10) / 10,
        feels_max_f:    Math.round(feelsMax * 10) / 10,
        feels_min_f:    Math.round(feelsMin * 10) / 10,
        precip_sum_in:  Math.round(precipSum * 100) / 100,
        precip_pct:     Math.round(precipPct),
        wind_max_mph:   Math.round(windMax * 10) / 10,
        gust_max_mph:   Math.round(gustMax * 10) / 10,
        avg_rh:         avgRH,
        wind_dir:       degToCardinal(windDirD),
        weather_code:   wmoCode,
        condition:      wmoToCondition(wmoCode),
        sunrise:        sunTimes.sunrise,
        sunset:         sunTimes.sunset,
        spray:          scoreSprayConditions(dailyHour, herbicide)
      });
    }

    // ── Summary stats ─────────────────────────────────────
    const favorableCount = hourly.filter(h => h.spray.status === 'favorable').length;
    const cautionCount   = hourly.filter(h => h.spray.status === 'caution').length;
    const noGoodCount    = hourly.filter(h => h.spray.status === 'no-good').length;

    let bestStart = null, bestLen = 0, curStart = null, curLen = 0;
    for (const h of hourly) {
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
      timezone: raw.timezone,
      hourly,
      daily
    });

  } catch (err) {
    console.error('Forecast error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

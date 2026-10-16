'use strict';

// Frozen Open-Meteo-shaped fixtures. Naive local times, no Z.
// nowLocal for these rows is 2026-10-16T13:00 (Lincoln / America/Chicago).

const NOW_LOCAL = '2026-10-16T13:00';
const TODAY = '2026-10-16';

function ymd(start, offsetDays) {
  const [y, m, d] = start.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offsetDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Build a past_days=7 + forecast_days=7 Open-Meteo payload.
 * startDate is today-7. Hourly precipitation can be set per hour key;
 * daily precipitation_sum is set per YYYY-MM-DD.
 */
function buildOpenMeteo({
  today = TODAY,
  pastDays = 7,
  forecastDays = 7,
  hourlyPrecip = {},
  dailyPrecip = {},
  soilMoisture = {},
  soilTempF = {},
  defaultMoisture = 0.22,
  defaultTempF = 58
} = {}) {
  const start = ymd(today, -pastDays);
  const totalDays = pastDays + forecastDays;
  const hourly = {
    time: [],
    precipitation: [],
    soil_moisture_0_to_1cm: [],
    soil_temperature_6cm: []
  };
  const daily = {
    time: [],
    precipitation_sum: []
  };

  for (let d = 0; d < totalDays; d++) {
    const date = ymd(start, d);
    daily.time.push(date);
    daily.precipitation_sum.push(
      dailyPrecip[date] != null ? dailyPrecip[date] : 0
    );
    for (let h = 0; h < 24; h++) {
      const time = `${date}T${pad2(h)}:00`;
      hourly.time.push(time);
      hourly.precipitation.push(hourlyPrecip[time] != null ? hourlyPrecip[time] : 0);
      hourly.soil_moisture_0_to_1cm.push(
        soilMoisture[time] != null ? soilMoisture[time] : defaultMoisture
      );
      hourly.soil_temperature_6cm.push(
        soilTempF[time] != null ? soilTempF[time] : defaultTempF
      );
    }
  }

  return {
    latitude: 40.8136,
    longitude: -96.7026,
    timezone: 'America/Chicago',
    utc_offset_seconds: -5 * 3600,
    hourly,
    daily
  };
}

// Main fixture: rain yesterday 0.40 in (at 18:00), drizzle today 0.05 in
// (at 08:00), 0.12 in six days ago. Current hour soil slightly moist.
const LINCOLN_AFTER_RAIN = buildOpenMeteo({
  dailyPrecip: {
    '2026-10-10': 0.12,
    '2026-10-15': 0.40,
    '2026-10-16': 0.05
  },
  hourlyPrecip: {
    '2026-10-10T06:00': 0.12,
    '2026-10-15T12:00': 0.10, // just outside a 13:00 trailing-24h window
    '2026-10-15T18:00': 0.30,
    '2026-10-16T08:00': 0.05
  },
  soilMoisture: { '2026-10-16T13:00': 0.22 },
  soilTempF: { '2026-10-16T13:00': 58.4 }
});

const LINCOLN_WET_TODAY = buildOpenMeteo({
  dailyPrecip: { '2026-10-16': 0.35 },
  hourlyPrecip: { '2026-10-16T09:00': 0.35 },
  soilMoisture: { '2026-10-16T13:00': 0.36 },
  soilTempF: { '2026-10-16T13:00': 61 }
});

const LINCOLN_DRY_SPELL = buildOpenMeteo({
  defaultMoisture: 0.08,
  defaultTempF: 64,
  soilMoisture: { '2026-10-16T13:00': 0.08 },
  soilTempF: { '2026-10-16T13:00': 64 }
});

module.exports = {
  NOW_LOCAL,
  TODAY,
  ymd,
  buildOpenMeteo,
  LINCOLN_AFTER_RAIN,
  LINCOLN_WET_TODAY,
  LINCOLN_DRY_SPELL
};

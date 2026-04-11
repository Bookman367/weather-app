export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { location, herbicide } = req.body;

  if (!location || !herbicide) {
    return res.status(400).json({ error: 'Missing location or herbicide' });
  }

  // Load products
  let products;
  try {
    // Static products (herbicide DB)
const products = {
  general: {name: "General Herbicide", restrictions: {min_temp_f:50, max_temp_f:90, max_wind_mph:15, max_precip_pct:30}, notes: "Generic criteria"},
  "2_4_d_amine": {name: "2,4-D Amine", restrictions: {min_temp_f:60, max_temp_f:85, max_wind_mph:15}, notes: "Common broadleaf killer"},
  dicamba: {name: "Dicamba (Clarity)", restrictions: {min_temp_f:65, max_wind_mph:10}, notes: "Volatile; wind-sensitive"},
  "grazon_next_hl": {name: "GrazonNext HL", restrictions: {min_temp_f:55, max_temp_f:90, min_rh_pct:40, max_rh_pct:85, max_wind_mph:10, max_gust_mph:15, max_precip_pct:20}, notes: "Avoid drift; temps >90 volatile (EPA label)", epa_url: "https://www3.epa.gov/pesticides/chem_search/ppls/000100-01221-20210405.pdf"},
  "grazon_p_d": {name: "Grazon P+D", restrictions: {min_temp_f:60, max_wind_mph:12, max_gust_mph:18}, notes: "Picloram + 2,4-D for broadleaf"}
};
    products = productsData.products;
  } catch {
    return res.status(500).json({ error: 'Products load failed' });
  }

  const herbicideKey = herbicide.toLowerCase().replace(/[, -]/g, '_');
  const product = Object.values(products).find(p => p.name.toLowerCase().includes(herbicideKey)) || products.general || { restrictions: {}, notes: 'General', name: 'General Herbicide' };
  const restrictions = product.restrictions;

  // Geocode
  let lat, lon;
  try {
    const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`, {
  headers: {
    'User-Agent': 'weather-spray-app/1.0 (contact@example.com)'
  }
});
    const geoData = await geoRes.json();
    if (geoData.length === 0) throw new Error('Location not found');
    lat = parseFloat(geoData[0].lat);
    lon = parseFloat(geoData[0].lon);
  } catch (e) {
    return res.status(400).json({ error: `Geocode fail: ${e.message}` });
  }

  // Open-Meteo forecast
  try {
    const forecastRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m&forecast_days=4&timezone=America/Chicago`);
    const forecast = await forecastRes.json();

    const times = forecast.hourly.time;
    const tempsC = forecast.hourly.temperature_2m;
    const rhs = forecast.hourly.relative_humidity_2m;
    const precips = forecast.hourly.precipitation_probability;
    const winds = forecast.hourly.wind_speed_10m;
    const gusts = forecast.hourly.wind_gusts_10m || [];

    let favorable = 0, caution = 0, nogood = 0;
    let bestWindow = '', bestScore = 0;

    const summaryLines = [`Spray Forecast for ${product.name} at ${location} (${lat.toFixed(2)}, ${lon.toFixed(2)})`];
    summaryLines.push('Next 96 hours (hourly):');
    summaryLines.push('');

    for (let i = 0; i < times.length; i++) {
      const tempF = tempsC[i] * 9/5 + 32;
      const rh = rhs[i];
      const precip = precips[i];
      const wind = winds[i];
      const gust = gusts[i] !== undefined ? gusts[i] : wind * 1.5;

      let score = 5;
      const issues = [];

      if (tempF < (restrictions.min_temp_f || 50)) { score -= 2; issues.push(`Low temp ${tempF.toFixed(0)}F`); }
      if (restrictions.max_temp_f && tempF > restrictions.max_temp_f) { score -= 2; issues.push(`High temp ${tempF.toFixed(0)}F`); }
      if (wind > (restrictions.max_wind_mph || 15)) { score -= 2; issues.push(`High wind ${wind.toFixed(0)}mph`); }
      if (gust > (restrictions.max_gust_mph || 20)) { score -= 1; issues.push(`High gust ${gust.toFixed(0)}mph`); }
      if (precip > (restrictions.max_precip_pct || 20)) { score -= 2; issues.push(`Precip ${precip}%`); }
      if (rh < (restrictions.min_rh_pct || 30)) { score -= 1; issues.push(`Low RH ${rh}%`); }

      const level = score >= 4 ? 'Favorable' : score >= 2 ? 'Caution' : 'No Good';
      if (level === 'Favorable') favorable++;
      else if (level === 'Caution') caution++;
      else nogood++;

      if (score > bestScore) {
        bestScore = score;
        bestWindow = `Hour ${i}: ${level} (score ${score}/5) - ${issues.length ? issues.join(', ') : 'All good'}`;
      }

      if (i % 12 === 0) {
        summaryLines.push(`H${Math.floor(i/12)*12}-${Math.floor(i/12)*12+11}: ${level} | Temp:${tempF.toFixed(0)}F Wind:${wind.toFixed(0)}gust:${gust.toFixed(0)} RH:${rh}% Precip:${precip}%`);
      }
    }

    summaryLines.push('');
    summaryLines.push(`Summary: Favorable:${favorable} Caution:${caution} No Good:${nogood}`);
    summaryLines.push(`Best window: ${bestWindow}`);
    summaryLines.push(product.notes || '');
    if (product.epa_url) summaryLines.push(`EPA: ${product.epa_url}`);

    res.status(200).send(summaryLines.join('\\n'));
  } catch (e) {
    res.status(500).json({ error: `Forecast fail: ${e.message}` });
  }
}
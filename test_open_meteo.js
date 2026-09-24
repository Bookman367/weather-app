const fetch = require('node-fetch');
async function test() {
  const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=42.35,42.4&longitude=-97.79,-97.8&hourly=temperature_2m&forecast_days=1');
  const data = await res.json();
  console.log(JSON.stringify(data[0].hourly.time.slice(0,2)));
}
test();

const handler = require('./api/spray-map.js');
async function test() {
  const req = {
    method: 'GET',
    query: {
      lat: '42.35',
      lon: '-97.79',
      radius: '30',
      product: 'general'
    }
  };
  const res = {
    headers: {},
    setHeader: function(key, val) { this.headers[key] = val; },
    status: function(code) { this.statusCode = code; return this; },
    json: function(data) { this.data = data; },
    end: function() {}
  };
  await handler(req, res);
  console.log('Status code:', res.statusCode);
  if (res.data && res.data.points && res.data.points.length > 0) {
    console.log('First point hourly count:', res.data.points[0].hourly.length);
    console.log('✅ API Test Passed');
  } else {
    console.log('❌ API Test Failed:', res.data);
  }
}
test();

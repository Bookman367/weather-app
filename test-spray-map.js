const assert = require('assert');
const { generateGrid } = require('./api/spray-map.js');
const { scoreHourly } = require('./lib/spray-logic.js');

async function runTests() {
  console.log("Running spray-map tests...");

  // Test grid generation
  const lat = 42.35;
  const lon = -97.79;
  const radius = 30;
  const gridSize = 7;

  const grid = generateGrid(lat, lon, radius, gridSize);

  assert.strictEqual(grid.length, gridSize * gridSize, `Grid should have ${gridSize * gridSize} points`);

  // Center point should be close to center of bounding box
  const firstPoint = grid[0];
  assert(firstPoint.lat > 0, "Latitude should be positive");
  assert(firstPoint.lon < 0, "Longitude should be negative");
  assert(firstPoint.bounds.length === 2, "Should have 2 bounds elements (min/max)");

  console.log("✅ Grid generation test passed");

  // Test scoring integration mock
  const mockHourly = [{
    time: "2023-10-01T12:00",
    hour_of_day: 12,
    temp_f: 75,
    wind_mph: 10,
    gust_mph: 15,
    rh: 50,
    delta_t: 5,
    delta_t_f: 9,
    precip_pct: 0
  }];

  const scored = scoreHourly(mockHourly, 'general', 'clarity');
  assert(scored[0].spray, "Should have a spray object attached");
  assert(scored[0].spray.status === 'favorable', "Status should be favorable for optimal conditions");

  console.log("✅ Hourly scoring mock test passed");

  console.log("All tests passed!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});

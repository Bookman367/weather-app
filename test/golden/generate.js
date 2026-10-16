'use strict';

/**
 * Rewrite committed golden snapshot files from today's Hero behavior.
 * Never run from npm test. After an intentional behavior change:
 *   node test/golden/generate.js
 * then review git diff before committing.
 */

const fs = require('fs');
const path = require('path');
const {
  stringifyGolden,
  buildScoreMatrix,
  buildDeltaTTable,
  buildOpenMeteo7d,
  buildSprayWindowGolden,
  buildForecastGolden,
  buildSprayMapGolden,
  buildStoresGolden,
  buildSunTimesGolden,
  buildWindDisplayGolden,
  buildUrlLocationGolden,
  buildSpotTimeGolden
} = require('./helpers');

const ROOT = __dirname;

async function writeGolden(relPath, data) {
  const dest = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, stringifyGolden(relPath, data));
  const bytes = fs.statSync(dest).size;
  console.log(`wrote ${relPath} (${bytes} bytes)`);
}

async function main() {
  await writeGolden('fixtures/open-meteo-7d.json', buildOpenMeteo7d());
  await writeGolden('score-matrix.golden.json', buildScoreMatrix());
  await writeGolden('delta-t-table.golden.json', buildDeltaTTable());
  await writeGolden('spray-map.golden.json', buildSprayMapGolden());
  await writeGolden('stores.golden.json', buildStoresGolden());
  await writeGolden('sun-times.golden.json', buildSunTimesGolden());
  await writeGolden('wind-display.golden.json', buildWindDisplayGolden());
  await writeGolden('url-location.golden.json', buildUrlLocationGolden());
  await writeGolden('spot-time.golden.json', buildSpotTimeGolden());
  await writeGolden('spray-window.golden.json', await buildSprayWindowGolden());
  await writeGolden('forecast.golden.json', await buildForecastGolden());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// OQ6 (M7): stands in for a developer's own preload (`NODE_OPTIONS=--require ./instrument.cjs`, as OpenTelemetry or
// dotenv setups do). It leaves a marker per process and loads the harness evidence hook, so a run where this preload
// is dropped also loses its evidence and fails loudly.
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.CB_E2E_EVIDENCE_DIR;
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `developer-preload.${process.pid}`), "");
}
require("../harness/evidence-hook.cjs");

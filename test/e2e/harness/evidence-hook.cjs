// Test harness only. Loaded into every Node process of the app via NODE_OPTIONS=--require (cb run keeps it).
// When the harness drops dump.request, each live process writes its process.env and a V8 heap snapshot (§13).
// File-based so it works the same on every OS (no signals).
const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");

const dir = process.env.CB_E2E_EVIDENCE_DIR;
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `hooked.${process.pid}`), process.argv.slice(1).join(" "));
  const request = path.join(dir, "dump.request");
  const timer = setInterval(() => {
    if (!fs.existsSync(request)) return;
    const stamp = fs.readFileSync(request, "utf8").trim();
    const done = path.join(dir, `dump.${process.pid}.${stamp}`);
    if (!stamp || fs.existsSync(done)) return;
    fs.writeFileSync(path.join(dir, `process-env.${process.pid}.json`), JSON.stringify(process.env));
    v8.writeHeapSnapshot(path.join(dir, `app.${process.pid}.heapsnapshot`));
    fs.writeFileSync(done, "");
  }, 200);
  timer.unref();
}

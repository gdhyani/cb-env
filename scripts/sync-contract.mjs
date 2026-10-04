// Generates TypeScript types from cb-backend's REST contract (PRD §12.1).
// Source: CB_CONTRACT_PATH (file path or URL), default ../cb-backend/contracts/openapi.yaml.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const source = process.env.CB_CONTRACT_PATH ?? path.resolve("..", "cb-backend", "contracts", "openapi.yaml");
if (!/^https?:\/\//.test(source) && !fs.existsSync(source)) {
  console.error(`sync:contract: contract not found at ${source}. Set CB_CONTRACT_PATH to a file path or URL.`);
  process.exit(1);
}
const out = path.join("src", "shared", "contract", "api.d.ts");
// Pinned and run through npx: it needs TypeScript 5 as a peer, so it stays out of this repo's dependencies.
const GENERATOR = "openapi-typescript@7.13.0";
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", GENERATOR, source, "--output", out], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log(`sync:contract: ${out} generated from ${source}`);

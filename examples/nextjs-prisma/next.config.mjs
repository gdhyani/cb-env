import path from "node:path";

// In this repo @cb/env is linked from ../.. (file: dependency); the root must contain it. Real apps install
// @cb/env from npm and need none of this.
const root = path.resolve(import.meta.dirname, "../..");

/** @type {import("next").NextConfig} */
const nextConfig = {
  outputFileTracingRoot: root,
  turbopack: { root },
};
export default nextConfig;

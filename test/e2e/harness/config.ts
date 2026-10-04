import os from "node:os";
import path from "node:path";
import { z } from "zod";

const Schema = z.object({
  CB_E2E_BACKEND_DIR: z.string().default(path.resolve(__dirname, "../../../../cb-backend")),
  CB_TEST_DB_PASSWORD: z.string().min(8).optional(),
  CB_TEST_REDIS_PASSWORD: z.string().min(8).optional(),
  CB_E2E_KEEP: z.enum(["0", "1"]).default("0"),
  CB_E2E_EVIDENCE: z.string().default(path.join(os.tmpdir(), "cb-e2e")),
});

export interface HarnessConfig {
  backendDir: string;
  /** Postgres/MySQL/SMTP/S3 password of docker-compose.test.yml (generated per CI run). */
  servicesPassword?: string;
  redisPassword?: string;
  keepEvidence: boolean;
  evidenceRoot: string;
  /** Repo root of @cb/env (the built CLI lives in dist/). */
  cbEnvDir: string;
}

export function loadHarnessConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const e = Schema.parse(env);
  return {
    backendDir: e.CB_E2E_BACKEND_DIR,
    servicesPassword: e.CB_TEST_DB_PASSWORD,
    redisPassword: e.CB_TEST_REDIS_PASSWORD,
    keepEvidence: e.CB_E2E_KEEP === "1",
    evidenceRoot: e.CB_E2E_EVIDENCE,
    cbEnvDir: path.resolve(__dirname, "../../.."),
  };
}

/** The e2e suites need the compose services; without their passwords they are skipped (unit CI). */
export const servicesAvailable = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.CB_TEST_DB_PASSWORD && env.CB_TEST_REDIS_PASSWORD);

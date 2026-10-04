import fs from "node:fs";
import path from "node:path";
import { type Canaries, makeCanaries, secretsOf } from "./canaries";
import { testTls } from "./certs";
import { type HarnessConfig, loadHarnessConfig } from "./config";
import { type MockUpstreams, startMockUpstreams } from "./mock-upstreams";
import { listFiles, type ScanReport, scanEvidence } from "./scan";
import { linkProject, loginCli, type Seeded, type SeedSpec, seedProject } from "./seed";
import { composeServices, startBackendMongo, startUpstreamMongo } from "./services";
import { startBackend } from "./stack";

export interface Suite {
  cfg: HarnessConfig;
  canaries: Canaries;
  mocks: MockUpstreams;
  services: ReturnType<typeof composeServices>;
  upstreamMongo?: { uri: string };
  evidence: string;
  cbHome: string;
  seeded?: Seeded;
  /** Saves something the app received, for the "responses delivered to the app" canary target. */
  saveResponse(name: string, value: unknown): void;
  /** Seeds the backend for `exampleDir` and logs the CLI in (real device-code flow). */
  seed(exampleDir: string, spec: SeedSpec): Promise<Seeded>;
  /** Stops the backend (flushing its log) and scans every §13 target. */
  scan(extraTargets?: Record<string, string[]>): Promise<ScanReport>;
  close(): Promise<void>;
}

/** One isolated cb world per e2e file: canaries, mocks, upstream MongoDB, backend DB and backend. */
export async function startSuite(name: string, opts: { mongo?: boolean } = {}): Promise<Suite> {
  const cfg = loadHarnessConfig();
  const evidence = path.join(cfg.evidenceRoot, `${name}-${Date.now()}`);
  fs.mkdirSync(evidence, { recursive: true });
  const cbHome = path.join(evidence, "cbhome");
  const canaries = makeCanaries();
  const tls = await testTls(path.join(evidence, "tls"));
  const mocks = await startMockUpstreams(canaries, tls.leaf);
  const services = composeServices(cfg.servicesPassword ?? "", cfg.redisPassword ?? "");
  const upstreamMongo = opts.mongo ? await startUpstreamMongo(canaries.mongoPassword) : undefined;
  const backendDb = await startBackendMongo();
  const backend = await startBackend(cfg, {
    mongoUri: backendDb.uri,
    caFile: tls.caFile,
    logFile: path.join(evidence, "backend.log"),
  });
  let stopped = false;
  const stopBackend = async () => {
    if (stopped) return;
    stopped = true;
    await backend.stop();
  };

  const suite: Suite = {
    cfg,
    canaries,
    mocks,
    services,
    upstreamMongo,
    evidence,
    cbHome,
    saveResponse(file, value) {
      fs.writeFileSync(
        path.join(evidence, `response.${file}.json`),
        typeof value === "string" ? value : JSON.stringify(value),
      );
    },
    async seed(exampleDir, spec) {
      const seeded = await seedProject(backend.url, spec);
      await loginCli(cfg, seeded, cbHome);
      linkProject(exampleDir, seeded);
      suite.seeded = seeded;
      return seeded;
    },
    async scan(extraTargets = {}) {
      await stopBackend();
      const inEvidence = (re: RegExp) =>
        fs
          .readdirSync(evidence)
          .filter((f) => re.test(f))
          .map((f) => path.join(evidence, f));
      return scanEvidence(secretsOf(canaries, [cfg.servicesPassword, cfg.redisPassword]), {
        "app process.env": inEvidence(/^process-env\.\d+\.json$/),
        "app heap snapshots": inEvidence(/^app\.\d+\.heapsnapshot$/),
        "agent heap snapshot": inEvidence(/^agent(\..+)?\.heapsnapshot$/),
        "CB_HOME (incl. agent log)": listFiles(cbHome),
        "backend log": [path.join(evidence, "backend.log")],
        "cb CLI output": [path.join(evidence, "cli.log")],
        "responses delivered to the app": inEvidence(/^response\..+\.json$/),
        ...extraTargets,
      });
    },
    async close() {
      await stopBackend();
      await mocks.close();
      await backendDb.stop();
      await upstreamMongo?.stop();
      // Heap snapshots can be large; keep evidence only on request (it never holds a real secret on success).
      if (!cfg.keepEvidence) fs.rmSync(evidence, { recursive: true, force: true });
    },
  };
  return suite;
}

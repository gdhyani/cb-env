# @cb/env

CLI (`cb`), local agent and preload for cb credentialless development environments.
Structure, conventions and rules: see the repo guide (`CLAUDE.md`).

## Develop

```bash
npm install
npm run build
node dist/cli/index.js status          # backend health (default server http://localhost:4200, override with --server or CB_SERVER_URL)
node dist/cli/index.js status --json
```

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Compile to `dist/` (CommonJS) |
| `npm test` | Vitest (builds first; CLI tests run the compiled bin) |
| `npm run typecheck` / `npm run lint` | TypeScript / Biome |
| `npm run test:e2e` | Example apps under `cb run` against the real backend, with the §13 canary scan (see below) |

## End-to-end proof (`examples/` + `test/e2e/`)

Three ordinary apps use official SDKs and know nothing about cb:
- `express-mongo`: mongoose, ioredis, Razorpay, S3 with presign, SES, nodemailer, FCM, APNs.
- `nest-mysql`: `@nestjs/config`, mysql2/Knex, Anthropic, SQS.
- `nextjs-prisma`: Next.js 15/16, Prisma, OpenAI streaming, Stripe, Auth.js/Google, edge middleware, server actions.

`npm run test:e2e` does the following:
1. Starts the backend (from `../cb-backend`, or `CB_E2E_BACKEND_DIR`) with fresh keys, plus mock HTTPS providers that hold unique per-run canary secrets.
2. Logs in through the real device-code flow and runs each app under `cb run`.
3. Fails if a canary appears in any of these places:
   - the app's `process.env` or heap
   - the agent's heap
   - `CB_HOME`
   - the CLI or backend logs
   - any response the app received
   - the Next.js client bundles

It also fails if a mock provider was ever shown a fake value.

```bash
# test services (cb-backend/docker-compose.test.yml); passwords are yours, exported only in this shell
export CB_TEST_DB_PASSWORD=… CB_TEST_REDIS_PASSWORD=…
docker compose -f ../cb-backend/docker-compose.test.yml up -d --wait
(cd examples/express-mongo && npm ci) && (cd examples/nest-mysql && npm ci && npm run build) && (cd examples/nextjs-prisma && npm ci)
npm run test:e2e                 # or: npm run test:e2e -- nextjs-prisma ; CB_E2E_KEEP=1 keeps the evidence folder
```

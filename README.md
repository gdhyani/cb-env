# @cb/env

Run your app with real databases and APIs without ever holding a real secret: the `cb` CLI, local agent and preload for cb credentialless development environments.

**Documentation:** the cb dashboard serves the docs at `/docs`; their source is in
[`content/docs/`](https://github.com/gdhyani/cb-dashboard/tree/main/content/docs) of gdhyani/cb-dashboard.

## Quick start

```bash
npm i -D @cb/env
npx cb login            # approve this device in the dashboard
npx cb init             # link this folder to a cb project and wire your package.json scripts
npm run dev             # your app now runs under cb
```

Your app reads stand-in values from `process.env`; the local agent tunnels its connections to the cb gateway,
which uses the real credential. To run any other command the same way:

```bash
npx cb run -- node server.js
```

`cb run` options: `--env <name>`, `--server <url>`, `--no-restart`, `--webhook-port <port>`.
Other commands: `cb whoami`, `cb logout`, `cb status`, `cb doctor`, `cb shell`, `cb env print`, `cb env use <name>`,
`cb types`, `cb up` / `cb down`, `cb agent status` / `cb agent stop`, `cb webhooks listen`.

## Development

```bash
npm install
npm run build
node dist/cli/index.js status          # backend health (default server http://localhost:4200, override with --server or CB_SERVER_URL)
node dist/cli/index.js status --json
```

### Scripts

| Script | What it does |
|---|---|
| `npm run build` | Compile to `dist/` (CommonJS) |
| `npm test` | Vitest (builds first; CLI tests run the compiled bin) |
| `npm run typecheck` / `npm run lint` | TypeScript / Biome |
| `npm run sync:contract` | Regenerate API types from `../cb-backend/contracts/openapi.yaml` |
| `npm run test:e2e` | Example apps under `cb run` against the real backend, with a canary leak scan (see below) |

### End-to-end proof (`examples/` + `test/e2e/`)

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

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

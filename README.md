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

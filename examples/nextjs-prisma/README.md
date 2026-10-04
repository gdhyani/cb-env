# nextjs-prisma (cb example, trial T3)

A Next.js App Router app using official SDKs:
- Prisma 7 (Postgres, `@prisma/adapter-pg`)
- OpenAI streaming
- Stripe
- Auth.js with Google, and Google's OAuth client
- edge middleware
- a server action
- `NEXT_PUBLIC_*` values

Nothing in `src/` knows about cb.

```bash
npm install
npx cb login && npx cb init
npm run db:push    # Prisma through the cb listener
npm run dev        # Turbopack; `npm run dev:webpack` for webpack; `npm run build && npm start`
```

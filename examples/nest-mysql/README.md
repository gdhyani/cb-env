# nest-mysql (cb example)

A NestJS app using official SDKs through `@nestjs/config`:
- mysql2 and Knex
- Anthropic
- AWS SQS

Nothing in `src/` knows about cb.

```bash
npm install && npm run build
npx cb login && npx cb init
npm run dev        # http://127.0.0.1:3200/mysql, /anthropic, /sqs, /config
```

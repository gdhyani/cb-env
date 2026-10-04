# express-mongo (cb example)

A plain Express app using official SDKs, configured only from `process.env`:
- mongoose
- ioredis
- Razorpay
- AWS S3, with presigned URLs
- SES
- nodemailer (SMTP)
- firebase-admin (FCM)
- `@parse/node-apn`

Nothing in `src/` knows about cb.

Under `cb run`, every value the app sees is a fake or a local listener address. The cb gateway swaps in the real credentials.

```bash
npm install
npx cb login && npx cb init     # links the project and wraps the scripts
npm run dev                     # http://127.0.0.1:3100/mongo, /redis, /razorpay, /s3, /ses, /mail, /fcm, /apns
```

The e2e canary suite (`npm run test:e2e` in `cb-env`) runs this app against mock upstreams. It fails if a real secret appears anywhere on the developer side.

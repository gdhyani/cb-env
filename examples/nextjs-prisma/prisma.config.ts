import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  // `prisma generate` needs no database; `db push` runs under cb run, where DATABASE_URL is the local listener.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});

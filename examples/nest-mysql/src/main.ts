import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function main() {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  const port = Number(process.env.PORT ?? 3200);
  await app.listen(port, "127.0.0.1");
  console.log(`nest-mysql on :${port}`);
}
void main();

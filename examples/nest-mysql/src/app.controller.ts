// A plain NestJS controller: official SDKs configured through @nestjs/config. Nothing here knows about cb.
import Anthropic from "@anthropic-ai/sdk";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import knex, { type Knex } from "knex";
import mysql from "mysql2/promise";

type Result = { ok: true; result: unknown } | { ok: false; error: string };
const wrap = async (fn: () => Promise<unknown>): Promise<Result> => {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

@Controller()
export class AppController {
  private readonly db: Knex;
  private readonly anthropic: Anthropic;
  private readonly sqs: SQSClient;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    this.db = knex({ client: "mysql2", connection: config.getOrThrow<string>("DATABASE_URL") });
    this.anthropic = new Anthropic({ apiKey: config.getOrThrow<string>("ANTHROPIC_API_KEY") });
    this.sqs = new SQSClient({
      region: config.getOrThrow<string>("AWS_REGION"),
      endpoint: config.getOrThrow<string>("SQS_ENDPOINT"),
      credentials: {
        accessKeyId: config.getOrThrow<string>("AWS_ACCESS_KEY_ID"),
        secretAccessKey: config.getOrThrow<string>("AWS_SECRET_ACCESS_KEY"),
      },
    });
  }

  @Get("health")
  health() {
    return { ok: true, result: "up" };
  }

  @Get("config")
  cfg() {
    return wrap(async () => ({ anthropicKeyLength: this.config.get<string>("ANTHROPIC_API_KEY")?.length ?? 0 }));
  }

  @Get("mysql")
  mysql() {
    return wrap(async () => {
      const conn = await mysql.createConnection(this.config.getOrThrow<string>("DATABASE_URL"));
      const [rows] = await conn.query("SELECT 1 + 1 AS two");
      await conn.end();
      if (!(await this.db.schema.hasTable("nest_orders")))
        await this.db.schema.createTable("nest_orders", (t) => {
          t.increments("id");
          t.string("sku");
        });
      await this.db("nest_orders").insert({ sku: "N1" });
      return { rows, found: await this.db("nest_orders").where({ sku: "N1" }).first() };
    });
  }

  @Get("anthropic")
  claude() {
    return wrap(async () => {
      const msg = await this.anthropic.messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
      return msg.content;
    });
  }

  @Get("sqs")
  queue() {
    return wrap(async () => {
      const endpoint = this.config.getOrThrow<string>("SQS_ENDPOINT");
      const sent = await this.sqs.send(
        new SendMessageCommand({ QueueUrl: `${endpoint}/000000000000/orders`, MessageBody: "hi" }),
      );
      return { messageId: sent.MessageId };
    });
  }
}

import { describe, expect, it } from "vitest";
import { resolveWebhookPort } from "../../src/cli/commands/run";

describe("FR-WH-003 which port cb run delivers webhooks to", () => {
  it("--webhook-port wins, then project.json webhookPort, then PORT the app sees", () => {
    expect(resolveWebhookPort("4100", 3060, { PORT: "8080" })).toBe(4100);
    expect(resolveWebhookPort(undefined, 3060, { PORT: "8080" })).toBe(3060);
    expect(resolveWebhookPort(undefined, undefined, { PORT: "8080" })).toBe(8080);
    expect(resolveWebhookPort(undefined, undefined, {})).toBeUndefined();
  });

  it("ignores a PORT that is not a port, and refuses a bad flag clearly", () => {
    expect(resolveWebhookPort(undefined, undefined, { PORT: "abc" })).toBeUndefined();
    expect(resolveWebhookPort(undefined, undefined, { PORT: "70000" })).toBeUndefined();
    expect(() => resolveWebhookPort("nope", undefined, {})).toThrow(/--webhook-port must be a port number/);
  });
});

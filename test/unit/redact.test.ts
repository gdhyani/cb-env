import { describe, expect, it } from "vitest";
import { redact } from "../../src/shared/redact";

describe("log redaction (S9, FR-AGT-008)", () => {
  it("S9 redacts bearer and basic Authorization headers", () => {
    expect(redact("authorization: Bearer abc.def.ghi123")).toBe("authorization: Bearer [redacted]");
    expect(redact('"Authorization":"Basic dXNlcjpwYXNz"')).toContain("[redacted]");
    expect(redact("Basic dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
  });

  it("S9 redacts cb device tokens and long token-like runs", () => {
    expect(redact("token cbd_abcDEF123_-xyz")).toBe("token cbd_[redacted]");
    const longRun = "A".repeat(20) + "b".repeat(20);
    expect(redact(`key=${longRun}`)).toBe("key=[redacted]");
  });

  it("S9 leaves ordinary log text alone", () => {
    expect(redact("attached shop/development on 127.0.0.1:7401")).toBe("attached shop/development on 127.0.0.1:7401");
  });

  it("M8 S9 bare Basic redacts base64 credentials but leaves prose like 'Basic configuration' alone", () => {
    expect(redact("Basic configuration loaded")).toBe("Basic configuration loaded");
    expect(redact("basic Settings and Basic authentication")).toBe("basic Settings and Basic authentication");
    expect(redact("Basic dXNlcjpwYXNz")).toBe("Basic [redacted]");
    expect(redact("sent Basic YWxhZGRpbjpvcGVuc2VzYW1l to upstream")).toBe("sent Basic [redacted] to upstream");
    expect(redact("Basic YTpi")).toBe("Basic [redacted]"); // a:b, the shortest real credential
  });
});

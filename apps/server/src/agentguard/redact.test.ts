import { describe, expect, it } from "vitest";
import {
  redactError,
  redactMetadata,
  redactString,
  registerSecretValues,
} from "./redact.js";

describe("redact", () => {
  it("redacts bearer tokens and sk- keys in strings", () => {
    expect(redactString("Authorization Bearer abc.def.ghi")).toContain("[REDACTED]");
    expect(redactString("key sk-abcdefghijklmnop")).toContain("[REDACTED]");
  });

  it("redacts sensitive object keys including AK/SK and Ark", () => {
    const redacted = redactMetadata({
      ARK_API_KEY: "secret-ark",
      authorization: "Bearer xyz",
      nested: { api_key: "nested-secret", safe: "ok" },
      note: "ARK_API_KEY=leaked-value",
    });
    expect(redacted.ARK_API_KEY).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect((redacted.nested as { api_key: string; safe: string }).api_key).toBe(
      "[REDACTED]",
    );
    expect((redacted.nested as { safe: string }).safe).toBe("ok");
    expect(String(redacted.note)).toContain("[REDACTED]");
  });

  it("redacts error messages", () => {
    expect(redactError("failed with Bearer tokensecret123")).toContain("[REDACTED]");
    expect(redactError(null)).toBeNull();
  });

  it("redacts registered values literally, longest-first, and idempotently", () => {
    const shorter = "known-secret";
    const longer = "known-secret-with+regex.*chars";
    registerSecretValues([shorter, longer, longer]);

    const once = redactString("value=" + longer);
    expect(once).toBe("value=[REDACTED]");
    expect(redactString(once)).toBe(once);
  });

  it("ignores registered values shorter than eight characters", () => {
    registerSecretValues(["test", "", null, undefined]);
    expect(redactString("test remains useful")).toBe("test remains useful");
  });
});

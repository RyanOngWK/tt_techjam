import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSecretRegistryForTests,
  redactError,
  redactMetadata,
  redactString,
  registerSecretValues,
} from "./redact.js";

describe("redact", () => {
  beforeEach(() => {
    __resetSecretRegistryForTests();
  });
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
    registerSecretValues([
      { label: "shorterField", value: shorter },
      { label: "longerField", value: longer },
      { label: "longerFieldRepeat", value: longer },
    ]);

    const once = redactString("value=" + longer);
    expect(once).toBe("value=[REDACTED]");
    expect(redactString(once)).toBe(once);
  });

  it("ignores registered values shorter than eight characters", () => {
    registerSecretValues([
      { label: "tooShort", value: "test" },
      { label: "empty", value: "" },
      { label: "missingNull", value: null },
      { label: "missingUndefined", value: undefined },
    ]);
    expect(redactString("test remains useful")).toBe("test remains useful");
  });

  it("reports the config field labels of values too short to register", () => {
    const result = registerSecretValues([
      { label: "authToken", value: "zqx9j" },
      { label: "arkApiKey", value: "long-enough-configured-secret" },
      { label: "unsetField", value: "" },
      { label: "absentField", value: null },
    ]);

    expect(result.skippedTooShort).toEqual(["authToken"]);
    expect(result.registered).toBe(1);
    expect(JSON.stringify(result)).not.toContain("zqx");
    expect(redactString("zqx9j stays readable")).toBe("zqx9j stays readable");
    expect(redactString("value=long-enough-configured-secret")).toBe(
      "value=[REDACTED]",
    );
  });

  it("clears registered secrets so later tests cannot inherit them", () => {
    registerSecretValues([
      { label: "priorField", value: "cross-test-secret-value" },
    ]);
    expect(redactString("has cross-test-secret-value")).toBe("has [REDACTED]");
    __resetSecretRegistryForTests();
    expect(redactString("has cross-test-secret-value")).toBe(
      "has cross-test-secret-value",
    );
  });
});

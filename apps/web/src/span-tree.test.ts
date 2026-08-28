import { describe, expect, it } from "vitest";
import { formatDuration } from "./span-tree";

describe("formatDuration", () => {
  it("renders null durations as an em dash", () => {
    expect(formatDuration(null, null)).toBe("—");
  });

  it("renders measured durations plainly", () => {
    expect(formatDuration(1500, "measured")).toBe("1.5s");
    expect(formatDuration(250, "measured")).toBe("250ms");
  });

  it("prefixes derived durations with a tilde", () => {
    expect(formatDuration(1500, "inter_item_delta")).toBe("~1.5s");
    expect(formatDuration(250, "inter_item_delta")).toBe("~250ms");
  });
});

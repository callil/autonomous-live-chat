import { describe, expect, it } from "vitest";
import { createTargetEnvelope, targetAttributes } from "../src/target.js";

describe("target envelope", () => {
  it("keeps stable semantic context and rounds viewport bounds", () => {
    expect(createTargetEnvelope({
      targetId: "message-composer",
      tag: "FORM",
      label: "  Message   composer ",
      page: "/settings/profile",
      rect: { x: 1.236, y: 2, width: 300.555, height: 80 },
    })).toEqual({
      targetId: "message-composer",
      tag: "form",
      label: "Message composer",
      page: "/settings/profile",
      rect: { x: 1.24, y: 2, width: 300.56, height: 80 },
    });
  });

  it("rejects unstable identifiers and unsafe pages", () => {
    expect(() => targetAttributes("div:nth-child(2)", "Composer")).toThrow();
    expect(() => createTargetEnvelope({ targetId: "composer", tag: "div", page: "https://example.com", rect: { x: 0, y: 0, width: 1, height: 1 } })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { createTargetEnvelope, targetAttributes, targetFromElement } from "../src/target.js";

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

  it("emits the documented target attributes and only includes opted-in text", () => {
    expect(targetAttributes("message-composer", "Message composer", { includeText: true })).toEqual({
      "data-app-harness-id": "message-composer",
      "data-app-harness-label": "Message composer",
      "data-app-harness-text": "true",
    });
  });

  it("does not accept legacy target attributes", () => {
    const legacyOnly = {
      tagName: "DIV",
      textContent: "Do not collect this",
      getAttribute(name: string) {
        return name === "data-target-id" ? "legacy-id" : name === "data-target-label" ? "Legacy target" : null;
      },
      hasAttribute(name: string) {
        return name === "data-target-text";
      },
      getBoundingClientRect() {
        return { x: 0, y: 0, width: 1, height: 1 };
      },
    } as unknown as Element;

    expect(() => targetFromElement(legacyOnly, "/")).toThrow("target IDs");
  });
});

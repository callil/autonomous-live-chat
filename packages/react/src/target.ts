import { AUTHORING_ENVELOPE_POLICY } from "@app-harness/contracts";

export type AppHarnessRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AppHarnessTarget = {
  targetId: string;
  tag: string;
  role?: string;
  label?: string;
  text?: string;
  page: string;
  rect: AppHarnessRectangle;
};

export type TargetSnapshot = Omit<AppHarnessTarget, "rect"> & { rect: AppHarnessRectangle };

export type TargetAttributeOptions = {
  /**
   * Opt the element's rendered text into the envelope. This is intentionally
   * a marker rather than an attribute value so hosts never copy content into
   * markup just for App Harness.
   */
  includeText?: boolean;
};

const TARGET_ID = new RegExp(`^[a-z0-9_-]{1,${AUTHORING_ENVELOPE_POLICY.targetIdCharacters}}$`, "iu");
const PAGE = new RegExp(`^/[a-zA-Z0-9/_-]{0,${AUTHORING_ENVELOPE_POLICY.pagePathCharacters - 1}}$`, "u");

function bounded(value: string | null | undefined, maximum: number): string | undefined {
  const normalized = value?.trim().replace(/\s+/gu, " ");
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

export function createTargetEnvelope(snapshot: TargetSnapshot): AppHarnessTarget {
  if (!TARGET_ID.test(snapshot.targetId)) throw new Error("App Harness target IDs must be stable, readable identifiers.");
  if (!PAGE.test(snapshot.page)) throw new Error("App Harness target pages must be same-origin paths.");
  const tag = snapshot.tag.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/u.test(tag)) throw new Error("App Harness target tags are invalid.");
  const numbers = [snapshot.rect.x, snapshot.rect.y, snapshot.rect.width, snapshot.rect.height];
  if (!numbers.every(Number.isFinite) || snapshot.rect.width < 0 || snapshot.rect.height < 0) throw new Error("App Harness target bounds are invalid.");
  return {
    targetId: snapshot.targetId,
    tag,
    role: bounded(snapshot.role, AUTHORING_ENVELOPE_POLICY.roleCharacters),
    label: bounded(snapshot.label, AUTHORING_ENVELOPE_POLICY.safeTextCharacters),
    text: bounded(snapshot.text, AUTHORING_ENVELOPE_POLICY.safeTextCharacters),
    page: snapshot.page,
    rect: Object.fromEntries(Object.entries(snapshot.rect).map(([key, value]) => [key, Math.round(value * 100) / 100])) as AppHarnessRectangle,
  };
}

/**
 * The only target markup contract understood by the reusable authoring layer:
 *
 * - `data-app-harness-id`: stable, host-defined identifier
 * - `data-app-harness-label`: concise static description
 * - `data-app-harness-text`: optional marker allowing rendered text in the envelope
 */
export function targetAttributes(targetId: string, label: string, options: TargetAttributeOptions = {}): Record<string, string> {
  if (!TARGET_ID.test(targetId)) throw new Error("App Harness target IDs must be stable, readable identifiers.");
  const safeLabel = bounded(label, AUTHORING_ENVELOPE_POLICY.safeTextCharacters);
  if (!safeLabel) throw new Error("App Harness targets need a concise label.");
  return {
    "data-app-harness-id": targetId,
    "data-app-harness-label": safeLabel,
    ...(options.includeText ? { "data-app-harness-text": "true" } : {}),
  };
}

export function targetFromElement(element: Element, page = window.location.pathname): AppHarnessTarget {
  const targetId = element.getAttribute("data-app-harness-id") ?? "";
  const rect = element.getBoundingClientRect();
  return createTargetEnvelope({
    targetId,
    tag: element.tagName,
    role: element.getAttribute("role") ?? undefined,
    label: element.getAttribute("data-app-harness-label") ?? undefined,
    text: element.hasAttribute("data-app-harness-text") ? element.textContent ?? undefined : undefined,
    page,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  });
}

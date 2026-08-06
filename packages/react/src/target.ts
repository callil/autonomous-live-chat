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

const TARGET_ID = /^[a-z0-9_-]{1,64}$/iu;
const PAGE = /^\/[a-zA-Z0-9/_-]{0,159}$/u;

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
    role: bounded(snapshot.role, 48),
    label: bounded(snapshot.label, 120),
    text: bounded(snapshot.text, 120),
    page: snapshot.page,
    rect: Object.fromEntries(Object.entries(snapshot.rect).map(([key, value]) => [key, Math.round(value * 100) / 100])) as AppHarnessRectangle,
  };
}

export function targetAttributes(targetId: string, label: string): Record<string, string> {
  if (!TARGET_ID.test(targetId)) throw new Error("App Harness target IDs must be stable, readable identifiers.");
  const safeLabel = bounded(label, 120);
  if (!safeLabel) throw new Error("App Harness targets need a concise label.");
  return { "data-app-harness-id": targetId, "data-app-harness-label": safeLabel };
}

export function targetFromElement(element: Element, page = window.location.pathname): AppHarnessTarget {
  const targetId = element.getAttribute("data-app-harness-id") ?? element.getAttribute("data-target-id") ?? "";
  const rect = element.getBoundingClientRect();
  return createTargetEnvelope({
    targetId,
    tag: element.tagName,
    role: element.getAttribute("role") ?? undefined,
    label: element.getAttribute("data-app-harness-label") ?? element.getAttribute("data-target-label") ?? element.getAttribute("aria-label") ?? undefined,
    text: element.hasAttribute("data-app-harness-text") || element.hasAttribute("data-target-text") ? element.textContent ?? undefined : undefined,
    page,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  });
}

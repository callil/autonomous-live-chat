import { FormEvent, ReactNode, useEffect, useId, useState } from "react";
import { AppHarnessTarget, targetFromElement } from "./target.js";

export type AppHarnessSubmission = {
  request: string;
  target: AppHarnessTarget;
};

export type AppHarnessProps = {
  children: ReactNode;
  onRequest: (submission: AppHarnessSubmission) => Promise<void> | void;
  onOpenActivity?: () => void;
  activityCount?: number;
};

const TARGET_SELECTOR = "[data-app-harness-id], [data-target-id]";

function CrosshairIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="4"/><path d="M10 2v4M10 14v4M2 10h4M14 10h4"/></svg>;
}

export function AppHarness({ children, onRequest, onOpenActivity, activityCount = 0 }: AppHarnessProps) {
  const composerId = useId();
  const [open, setOpen] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const [hoverRect, setHoverRect] = useState<AppHarnessTarget["rect"]>();
  const [target, setTarget] = useState<AppHarnessTarget>();
  const [request, setRequest] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "submitted" | "error">("idle");

  useEffect(() => {
    if (!targeting) {
      setHoverRect(undefined);
      return;
    }
    const candidate = (event: Event): Element | null => {
      return event.target instanceof Element ? event.target.closest(TARGET_SELECTOR) : null;
    };
    const move = (event: PointerEvent) => {
      const element = candidate(event);
      if (!element) return setHoverRect(undefined);
      const rect = element.getBoundingClientRect();
      setHoverRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    const select = (event: MouseEvent) => {
      const element = candidate(event);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(targetFromElement(element));
      setTargeting(false);
      setStatus("idle");
      setOpen(true);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("click", select, true);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("click", select, true);
    };
  }, [targeting]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = request.trim();
    if (!target || !normalized || status === "submitting") return;
    setStatus("submitting");
    try {
      await onRequest({ request: normalized, target });
      setStatus("submitted");
    } catch {
      setStatus("error");
    }
  };

  return <>
    {children}
    <div className="ah-layer" data-app-harness-overlay="true">
      {hoverRect && <div className="ah-highlight" style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.width, height: hoverRect.height }} />}
      {open && <section className="ah-panel" aria-label="App Harness" data-app-harness-id="authoring-panel" data-app-harness-label="App Harness authoring panel">
        <header><strong>App Harness</strong><button type="button" aria-label="Close App Harness" data-app-harness-id="close-authoring" data-app-harness-label="Close App Harness" onClick={() => setOpen(false)}>×</button></header>
        {!target ? <div className="ah-actions">
          <button type="button" aria-pressed={targeting} data-app-harness-id="target-control" data-app-harness-label="Target control" onClick={() => setTargeting((value) => !value)}><CrosshairIcon />Target an element</button>
          {onOpenActivity && <button type="button" data-app-harness-id="activity-control" data-app-harness-label="Activity control" onClick={onOpenActivity}>Activity{activityCount ? ` · ${activityCount}` : ""}</button>}
        </div> : <form aria-labelledby={composerId} onSubmit={submit}>
          <label id={composerId} htmlFor={`${composerId}-request`}>Target: {target.label ?? target.targetId}</label>
          <textarea id={`${composerId}-request`} autoFocus value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Describe the change" />
          <div className="ah-form-meta"><button type="submit" disabled={!request.trim() || status === "submitting"}>{status === "submitting" ? "Submitting…" : "Submit"}</button></div>
          {status === "submitted" && <p role="status">Request submitted.</p>}
          {status === "error" && <p role="alert">The request could not be submitted.</p>}
          <button className="ah-back" type="button" onClick={() => { setTarget(undefined); setRequest(""); setStatus("idle"); }}>Choose another target</button>
        </form>}
      </section>}
      <button className="ah-launcher" type="button" data-app-harness-id="authoring-launcher" data-app-harness-label="App Harness launcher" aria-label={open ? "Close App Harness" : "Open App Harness"} aria-expanded={open} onClick={() => setOpen((value) => !value)}><CrosshairIcon />{!open && activityCount > 0 && <span>{activityCount}</span>}</button>
    </div>
  </>;
}

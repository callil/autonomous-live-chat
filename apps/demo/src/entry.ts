import handler, { ChatRoom, LedgerService } from "./index.js";

export { ChatRoom, LedgerService };

const AVATAR_SCRIPT = '<script src="/avatar-colors.js" defer></script>';
const COMPOSER_HINT = '<span class="hint">Shared live · press Enter to send, Shift + Enter for a new line</span>';
const SHIPPED_LIVE_FOOTER = '<span class="shipped-live">Shipped live by App Harness.</span>';
const SITE_TARGET_BODY = '<body data-app-harness-id="entire-site" data-app-harness-label="Entire site">';

const HARNESS_TOOLBAR_STYLES = `<style>
  .harness-launcher { display: none !important; }
  .authoring-popover {
    right: var(--overlay-edge); bottom: var(--overlay-edge); width: auto; max-width: calc(100vw - 2 * var(--overlay-edge));
    display: block !important; padding: .25rem; border-color: var(--color-control); border-radius: var(--radius-round);
    background: var(--color-control); color: var(--color-on-control); box-shadow: var(--shadow-control); animation: none;
  }
  .authoring-heading { display: none; }
  .authoring-tools { display: flex; align-items: center; gap: .125rem; }
  .authoring-tools .harness-tool, .authoring-tools .annotation-toggle {
    width: auto; min-width: var(--control-size); min-height: var(--control-size); justify-content: center; gap: .375rem;
    margin: 0; padding: 0 .625rem; border: 0; border-radius: var(--radius-round); color: var(--color-on-control);
  }
  .authoring-tools .harness-tool:hover, .authoring-tools .annotation-toggle:hover,
  .authoring-tools .harness-tool[aria-pressed="true"] { background: rgba(255,255,255,.16); }
  .authoring-tools .annotation-toggle { border-left: 1px solid rgba(255,255,255,.22); border-radius: 0 var(--radius-round) var(--radius-round) 0; }
  .authoring-tools svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .active-status-dot { flex: 0 0 auto; width: .4375rem; height: .4375rem; border-radius: 50%; background: #65d996; }
  .active-status-dot.working { animation: harness-status-pulse 1.35s ease-out infinite; }
  .authoring-notice { display: none !important; }
  .work-item[data-terminal="true"] { display: none; }
  .work-item[data-active-issue="true"] > :not(.active-issue-line) { display: none; }
  .active-issue-line { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .active-issue-line a { color: inherit; font-weight: 600; white-space: nowrap; }
  .active-issue-status { overflow: hidden; color: var(--color-text-secondary); text-overflow: ellipsis; white-space: nowrap; }
  .comment-preview {
    position: fixed; z-index: 3; width: min(18rem, calc(100vw - 2rem)); padding: .75rem 2rem .75rem .875rem;
    border: 1px solid var(--color-border-strong); border-radius: var(--radius-control); background: var(--color-surface);
    box-shadow: var(--shadow-overlay); color: var(--color-text); font-size: var(--type-label); line-height: var(--leading-body);
    pointer-events: auto;
  }
  .comment-preview-dismiss {
    position: absolute; top: .25rem; right: .25rem; width: 1.5rem; height: 1.5rem; padding: 0; border: 0;
    border-radius: var(--radius-small); background: transparent; color: var(--color-text-secondary); cursor: pointer;
  }
  .comment-preview-dismiss:hover { background: var(--color-surface-hover); color: var(--color-text); }
  .comment-pin { cursor: pointer; }
  body.harness-parent-targeting [data-app-harness-id]:not(body) [data-app-harness-id] { pointer-events: none !important; }
  @keyframes harness-status-pulse { 0% { box-shadow: 0 0 0 0 rgba(101,217,150,.8); } 70%,100% { box-shadow: 0 0 0 .45rem rgba(101,217,150,0); } }
  @media (prefers-reduced-motion: reduce) { .active-status-dot.working { animation: none; } }
  @media (max-width: 64rem) { .authoring-popover { bottom: var(--narrow-launcher-bottom); } }
  @media (max-width: 40rem) { .harness-tool span { display: none; } .authoring-tools .harness-tool { padding: 0 .55rem; } }
</style>`;

// The demo is intentionally build-free, so enhance its annotation shell after the inline client has attached its handlers.
const HARNESS_TOOLBAR_SCRIPT = `<script>
(() => {
  const popover = document.querySelector('#authoring-popover');
  const launcher = document.querySelector('#harness-launcher');
  const tools = document.querySelector('.authoring-tools');
  const activity = document.querySelector('#annotation-count');
  const count = document.querySelector('#activity-count-label');
  const list = document.querySelector('#work-item-list');
  const requestForm = document.querySelector('#target-composer');
  const requestInput = document.querySelector('#target-request-input');
  const requestStatus = document.querySelector('#target-request-error');
  const done = document.querySelector('#done-target-request');
  const annotationPanel = document.querySelector('#annotation-panel');
  const commentLayer = document.querySelector('#comment-layer');
  if (!popover || !tools || !activity || !count) return;

  // Lucide's open-source line icons replace the original bespoke icon set.
  const icons = {
    target: '<svg data-icon-library="lucide" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
    comment: '<svg data-icon-library="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/></svg>',
    draw: '<svg data-icon-library="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19 7-7 3 3-7 7-4 1 1-4zM18 13l-7-7 3-3 7 7M2 22l5-1-4-4-1 5z"/></svg>'
  };
  [['#target-mode', 'target'], ['#comment-mode', 'comment'], ['#draw-mode', 'draw']].forEach(([selector, icon]) => {
    const button = document.querySelector(selector);
    const label = button?.querySelector('span')?.textContent || '';
    if (button) button.innerHTML = icons[icon] + '<span>' + label + '</span>';
  });
  ['#target-mode', '#comment-mode'].forEach(selector => {
    const button = document.querySelector(selector);
    if (button) button.title += ' · Hold Shift for parent container';
  });
  const setParentTargeting = active => document.body.classList.toggle('harness-parent-targeting', active);
  window.addEventListener('keydown', event => { if (event.key === 'Shift') setParentTargeting(true); });
  window.addEventListener('keyup', event => { if (event.key === 'Shift') setParentTargeting(false); });
  window.addEventListener('blur', () => setParentTargeting(false));

  activity.replaceChildren(count);
  tools.append(activity);

  // Open once to initialize the existing targeting layer, then keep the complete pill visible without a launcher click.
  if (launcher?.getAttribute('aria-expanded') === 'false') launcher.click();
  popover.hidden = false;
  new MutationObserver(() => { if (popover.hidden) popover.hidden = false; }).observe(popover, { attributes: true, attributeFilter: ['hidden'] });

  const refreshActiveIssues = () => {
    const rows = [...(list?.querySelectorAll('.work-item') || [])];
    const active = [];
    rows.forEach(row => {
      const phase = row.querySelector('.work-item-phase');
      const terminal = Boolean(phase?.classList.contains('completed') || phase?.classList.contains('rejected'));
      row.dataset.terminal = terminal ? 'true' : 'false';
      if (!phase || terminal) return;
      active.push(row);
      row.dataset.activeIssue = 'true';
      if (row.querySelector('.active-issue-line')) return;
      const line = document.createElement('div');
      line.className = 'active-issue-line';
      const dot = document.createElement('i');
      dot.className = 'active-status-dot' + (phase.classList.contains('needs_review') ? '' : ' working');
      dot.setAttribute('aria-hidden', 'true');
      const issue = row.querySelector('.work-item-links a[href*="/issues/"]');
      const issueLabel = issue?.textContent?.replace(/^Issue /, '') || 'Issue pending';
      const issueElement = issue ? issue.cloneNode(true) : document.createElement('span');
      issueElement.textContent = issueLabel;
      const status = document.createElement('span');
      status.className = 'active-issue-status';
      status.textContent = phase.textContent || 'Active';
      line.setAttribute('aria-label', issueLabel + ': ' + status.textContent + (dot.classList.contains('working') ? ', working' : ''));
      line.append(dot, issueElement, status);
      row.prepend(line);
    });
    count.textContent = String(active.length);
    activity.setAttribute('aria-label', 'Open ' + active.length + ' active issue' + (active.length === 1 ? '' : 's'));
    activity.title = active.length + ' active issue' + (active.length === 1 ? '' : 's');
  };
  if (list) {
    new MutationObserver(refreshActiveIssues).observe(list, { childList: true, subtree: true });
    refreshActiveIssues();
  }

  // Activity follows delivery work only; canvas annotation management does not belong in this feed.
  if (annotationPanel) {
    const canvasHeading = [...annotationPanel.querySelectorAll('.annotation-panel-header')]
      .find(header => header.textContent?.includes('Canvas marks'));
    annotationPanel.querySelector('.activity-divider')?.remove();
    canvasHeading?.remove();
    annotationPanel.querySelector('#annotation-list')?.remove();
    annotationPanel.querySelector('#annotation-clear')?.remove();
  }

  // Comment dots preview on hover/focus and remain open after activation until explicitly dismissed.
  if (commentLayer) {
    const preview = document.createElement('aside');
    preview.className = 'comment-preview';
    preview.id = 'comment-preview';
    preview.hidden = true;
    preview.setAttribute('role', 'dialog');
    preview.setAttribute('aria-label', 'Canvas comment');
    const previewText = document.createElement('span');
    const dismiss = document.createElement('button');
    dismiss.className = 'comment-preview-dismiss';
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss comment');
    dismiss.textContent = '×';
    preview.append(previewText, dismiss);
    document.querySelector('.harness-frame')?.append(preview);
    let activePin;
    let pinned = false;
    let hideTimer;
    const preparePins = () => commentLayer.querySelectorAll('.comment-pin').forEach(pin => {
      if (!pin.dataset.comment) pin.dataset.comment = pin.title;
      pin.removeAttribute('title');
      pin.tabIndex = 0;
      pin.setAttribute('role', 'button');
      pin.setAttribute('aria-label', 'Open comment: ' + pin.dataset.comment);
      pin.setAttribute('aria-controls', preview.id);
      pin.setAttribute('aria-expanded', pin === activePin && !preview.hidden ? 'true' : 'false');
    });
    const positionPreview = pin => {
      const pinRect = pin.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      const edge = 8;
      preview.style.left = Math.max(edge, Math.min(pinRect.left, innerWidth - previewRect.width - edge)) + 'px';
      preview.style.top = Math.max(edge, Math.min(pinRect.bottom + edge, innerHeight - previewRect.height - edge)) + 'px';
    };
    const showComment = (pin, keepOpen = false) => {
      clearTimeout(hideTimer);
      if (activePin && activePin !== pin) activePin.setAttribute('aria-expanded', 'false');
      activePin = pin;
      pinned = keepOpen || pinned;
      previewText.textContent = pin.dataset.comment || '';
      preview.hidden = false;
      pin.setAttribute('aria-expanded', 'true');
      positionPreview(pin);
    };
    const dismissComment = (restoreFocus = false) => {
      clearTimeout(hideTimer);
      const previousPin = activePin;
      previousPin?.setAttribute('aria-expanded', 'false');
      activePin = undefined;
      pinned = false;
      preview.hidden = true;
      if (restoreFocus && previousPin?.isConnected) previousPin.focus();
    };
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!pinned) dismissComment(); }, 80);
    };
    commentLayer.addEventListener('mouseover', event => {
      const pin = event.target.closest?.('.comment-pin');
      if (pin && !pin.contains(event.relatedTarget)) showComment(pin);
    });
    commentLayer.addEventListener('mouseout', event => {
      const pin = event.target.closest?.('.comment-pin');
      if (pin && !pin.contains(event.relatedTarget)) scheduleHide();
    });
    commentLayer.addEventListener('focusin', event => {
      const pin = event.target.closest?.('.comment-pin');
      if (pin) showComment(pin);
    });
    commentLayer.addEventListener('focusout', event => {
      if (event.target.closest?.('.comment-pin')) scheduleHide();
    });
    commentLayer.addEventListener('click', event => {
      const pin = event.target.closest?.('.comment-pin');
      if (!pin) return;
      event.preventDefault();
      pinned = true;
      showComment(pin, true);
    });
    preview.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    preview.addEventListener('mouseleave', scheduleHide);
    dismiss.addEventListener('click', () => dismissComment(true));
    document.addEventListener('pointerdown', event => {
      if (pinned && !preview.contains(event.target) && !event.target.closest?.('.comment-pin')) dismissComment();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !preview.hidden) dismissComment(true); });
    new MutationObserver(() => {
      if (activePin && !activePin.isConnected) dismissComment();
      preparePins();
    }).observe(commentLayer, { childList: true });
    preparePins();
  }

  requestForm?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      requestForm.requestSubmit();
    }
  });
  if (requestStatus && done) new MutationObserver(() => {
    if (requestStatus.classList.contains('acknowledged') && !done.hidden) {
      if (requestInput) {
        requestInput.value = '';
        requestInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      done.click();
    }
  }).observe(requestStatus, { attributes: true, childList: true });
})();
</script>`;

type DemoHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/version") {
			// The deployed revision, injected at deploy time (--var DEPLOY_SHA).
			// The platform's observed-deploy loop polls this: "Live" only posts
			// once this endpoint actually serves the merged SHA.
			const sha = (env as { DEPLOY_SHA?: string }).DEPLOY_SHA;
			return Response.json({ sha: typeof sha === "string" && /^[0-9a-f]{40}$/u.test(sha) ? sha : null }, { headers: { "cache-control": "no-store" } });
		}
		if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			const asset = await env.ASSETS.fetch(request);
			const headers = new Headers(asset.headers);
			headers.delete("content-encoding");
			headers.delete("content-length");
			headers.delete("etag");
			const html = (await asset.text())
				.replace("</head>", `${AVATAR_SCRIPT}${HARNESS_TOOLBAR_STYLES}</head>`)
				.replace("<body>", SITE_TARGET_BODY)
				.replace(COMPOSER_HINT, `${COMPOSER_HINT}${SHIPPED_LIVE_FOOTER}`)
				.replace("</body>", `${HARNESS_TOOLBAR_SCRIPT}</body>`);
			return new Response(html, {
				status: asset.status,
				statusText: asset.statusText,
				headers,
			});
		}
		return (handler as unknown as DemoHandler).fetch(request, env, ctx);
	},
};

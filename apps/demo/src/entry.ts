import handler, { ChatRoom, LedgerService } from "./index.js";

export { ChatRoom, LedgerService };

const AVATAR_SCRIPT = '<script src="/avatar-colors.js" defer></script>';
const COMPOSER_HINT = '<span class="hint">Shared live · press Enter to send, Shift + Enter for a new line</span>';
const SHIPPED_LIVE_FOOTER = '<span class="shipped-live">Shipped live by App Harness.</span>';

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
  .active-status-dot { width: .4375rem; height: .4375rem; border-radius: 50%; background: #65d996; }
  .active-status-dot.working { animation: harness-status-pulse 1.35s ease-out infinite; }
  .authoring-notice { display: none !important; }
  .work-item[data-terminal="true"] { display: none; }
  @keyframes harness-status-pulse { 0% { box-shadow: 0 0 0 0 rgba(101,217,150,.8); } 70%,100% { box-shadow: 0 0 0 .45rem rgba(101,217,150,0); } }
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
  const requestStatus = document.querySelector('#target-request-error');
  const done = document.querySelector('#done-target-request');
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
  activity.replaceChildren(count);
  const pulse = document.createElement('i');
  pulse.className = 'active-status-dot';
  pulse.setAttribute('aria-hidden', 'true');
  activity.insertBefore(pulse, count);
  tools.append(activity);

  // Open once to initialize the existing targeting layer, then keep the complete pill visible without a launcher click.
  if (launcher?.getAttribute('aria-expanded') === 'false') launcher.click();
  popover.hidden = false;
  new MutationObserver(() => { if (popover.hidden) popover.hidden = false; }).observe(popover, { attributes: true, attributeFilter: ['hidden'] });

  const refreshActiveIssues = () => {
    const rows = [...(list?.querySelectorAll('.work-item') || [])];
    const active = [];
    rows.forEach(row => {
      const phase = row.querySelector('.work-item-phase')?.classList;
      const terminal = Boolean(phase?.contains('completed') || phase?.contains('rejected'));
      row.dataset.terminal = terminal ? 'true' : 'false';
      if (phase && !terminal) active.push(row);
    });
    count.textContent = String(active.length);
    activity.setAttribute('aria-label', 'Open ' + active.length + ' active issue' + (active.length === 1 ? '' : 's'));
    activity.title = active.length + ' active issue' + (active.length === 1 ? '' : 's');
    pulse.hidden = active.length === 0;
    pulse.classList.toggle('working', active.some(row => !row.querySelector('.work-item-phase.needs_review')));
  };
  if (list) {
    new MutationObserver(refreshActiveIssues).observe(list, { childList: true, subtree: true });
    refreshActiveIssues();
  }

  requestForm?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      requestForm.requestSubmit();
    }
  });
  if (requestStatus && done) new MutationObserver(() => {
    if (requestStatus.classList.contains('acknowledged') && !done.hidden) done.click();
  }).observe(requestStatus, { attributes: true, childList: true });
})();
</script>`;

type DemoHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			const asset = await env.ASSETS.fetch(request);
			const headers = new Headers(asset.headers);
			headers.delete("content-encoding");
			headers.delete("content-length");
			headers.delete("etag");
			const html = (await asset.text())
				.replace("</head>", `${AVATAR_SCRIPT}${HARNESS_TOOLBAR_STYLES}</head>`)
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

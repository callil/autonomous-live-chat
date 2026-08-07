import handler, { ChatRoom, LedgerService } from "./index.js";

export { ChatRoom, LedgerService };

const AVATAR_SCRIPT = '<script src="/avatar-colors.js" defer></script>';
const COMPOSER_HINT = '<span class="hint">Shared live · press Enter to send, Shift + Enter for a new line</span>';
const SHIPPED_LIVE_FOOTER = '<span class="shipped-live">Shipped live by App Harness.</span>';

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
				.replace("</head>", `${AVATAR_SCRIPT}</head>`)
				.replace(COMPOSER_HINT, `${COMPOSER_HINT}${SHIPPED_LIVE_FOOTER}`);
			return new Response(html, {
				status: asset.status,
				statusText: asset.statusText,
				headers,
			});
		}
		return (handler as unknown as DemoHandler).fetch(request, env, ctx);
	},
};

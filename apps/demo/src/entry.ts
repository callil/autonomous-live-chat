import handler, { ChatRoom, LedgerService } from "./index.js";

export { ChatRoom, LedgerService };

const AVATAR_SCRIPT = '<script src="/avatar-colors.js" defer></script>';

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
			return new Response((await asset.text()).replace("</head>", `${AVATAR_SCRIPT}</head>`), {
				status: asset.status,
				statusText: asset.statusText,
				headers,
			});
		}
		return (handler as unknown as DemoHandler).fetch(request, env, ctx);
	},
};

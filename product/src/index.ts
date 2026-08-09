import roomHtml from "./ui/room.html";
import roomCss from "./ui/room.css";
import roomClient from "./ui/room.client.js";
import { stampDataLoc } from "./stamp.js";

/**
 * The PRODUCT worker (phase 3 split): serves the self-modifiable room UI and
 * proxies /api/* verbatim to the frozen platform — the room WebSocket rides
 * the same proxy, so the platform's signed session cookie is a plain
 * same-origin cookie here. This worker has ZERO bindings: no Durable
 * Objects, no services, no ledger access of any kind.
 */

type ProductEnv = {
	PLATFORM_ORIGIN: string;
	/** Injected at deploy time (--var DEPLOY_SHA) so /version serves the exact revision. */
	DEPLOY_SHA?: string;
};

/**
 * The room page, stamped ONCE at module init with data-loc="<file>:<line>"
 * structural refs over the verbatim bundled source (the build-time transform
 * the annotation envelopes anchor to). If stamping ever fails, the page is
 * null and every visit falls back to the platform's frozen minimal UI —
 * the error boundary in code, not just in the page.
 */
const STAMPED_ROOM_PAGE: string | null = (() => {
	try {
		return stampDataLoc(roomHtml, "product/src/ui/room.html");
	} catch (error) {
		console.error("Room page stamping failed; serving the platform fallback.", { error: error instanceof Error ? error.message : String(error) });
		return null;
	}
})();

const NO_STORE = { "cache-control": "no-store" };

export default {
	async fetch(request: Request, env: ProductEnv): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/version") {
			// The deployed revision. The platform's observed-deploy loop polls
			// this: "Live" only posts once it serves the merged SHA.
			const sha = env.DEPLOY_SHA;
			return Response.json({ sha: typeof sha === "string" && /^[0-9a-f]{40}$/u.test(sha) ? sha : null }, { headers: NO_STORE });
		}

		if (url.pathname === "/api/rooms/main" || url.pathname.startsWith("/api/")) {
			// The narrow seam to the platform: same path, same method, same
			// headers (cookies included), same body — WebSocket upgrades ride
			// through untouched. Nothing is rewritten and nothing is stored.
			const upstream = new URL(url.pathname + url.search, env.PLATFORM_ORIGIN);
			return fetch(new Request(upstream.toString(), request));
		}

		if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

		if (url.pathname === "/" || url.pathname === "/index.html") {
			if (STAMPED_ROOM_PAGE === null) return Response.redirect(new URL("/fallback", env.PLATFORM_ORIGIN).toString(), 302);
			// The in-page error boundary points at the platform's frozen
			// fallback via this meta ref (absolute, so it works even when the
			// product worker itself is the broken part).
			const page = STAMPED_ROOM_PAGE.replace(
				'<meta name="ahp-fallback" content="/fallback">',
				`<meta name="ahp-fallback" content="${new URL("/fallback", env.PLATFORM_ORIGIN).toString()}">`,
			);
			return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } });
		}
		if (url.pathname === "/assets/room.css") {
			return new Response(roomCss, { headers: { "content-type": "text/css; charset=utf-8", ...NO_STORE } });
		}
		if (url.pathname === "/assets/room.client.js") {
			return new Response(roomClient, { headers: { "content-type": "text/javascript; charset=utf-8", ...NO_STORE } });
		}
		return new Response("Not found", { status: 404 });
	},
};

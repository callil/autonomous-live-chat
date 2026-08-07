export * from "./operator-gatekeeper.js";
export type * from "./operator-gatekeeper.contract.js";
export type * from "./types.js";

export default {
	async fetch(): Promise<Response> {
		return new Response("App Harness operator Gatekeeper worker is running.", {
			headers: { "content-type": "text/plain" },
		});
	},
};

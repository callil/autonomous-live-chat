// Text-module declarations for the UI sources bundled via the wrangler
// `rules` config (type: "Text"). The worker stamps and serves them verbatim.
declare module "*.html" {
	const text: string;
	export default text;
}
declare module "*.css" {
	const text: string;
	export default text;
}
declare module "*.client.js" {
	const text: string;
	export default text;
}

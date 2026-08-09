/**
 * Build-time data-loc stamping (phase 3): every element in the room UI's
 * source HTML gets a `data-loc="<file>:<line>"` structural ref, injected
 * when the worker module initializes over the verbatim bundled source. The
 * overlay captures these refs into annotation envelopes, so the coding agent
 * can point straight at the source line the requester marked.
 *
 * Deterministic and idempotent: the same source always stamps the same way,
 * and an element that already carries data-loc is left alone.
 */

/** Structural chrome and unstampable tags that never need a ref. */
const SKIP_TAGS = new Set(["html", "head", "meta", "link", "title", "script", "style", "br", "hr", "!doctype"]);

const OPENING_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\s*\/?)>/gu;

export function stampDataLoc(html, file) {
	if (typeof html !== "string" || typeof file !== "string" || !file.length) throw new Error("Stamping requires the source text and its file path.");
	let inRawText = false;
	return html.split("\n").map((line, index) => {
		// Never rewrite inside <script>/<style> bodies: their contents are
		// code, not markup.
		if (inRawText) {
			if (/<\/(script|style)>/iu.test(line)) inRawText = false;
			return line;
		}
		const stamped = line.replace(OPENING_TAG, (match, tag, attrs, close) => {
			const lower = tag.toLowerCase();
			if (SKIP_TAGS.has(lower)) return match;
			if (/\bdata-loc=/u.test(attrs)) return match;
			return `<${tag}${attrs} data-loc="${file}:${index + 1}"${close}>`;
		});
		if (/<(script|style)(\s|>)/iu.test(line) && !/<\/(script|style)>/iu.test(line)) inRawText = true;
		return stamped;
	}).join("\n");
}

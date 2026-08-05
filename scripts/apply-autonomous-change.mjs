import { readFile, writeFile } from "node:fs/promises";

const request = (process.env.AUTONOMY_REQUEST ?? "").trim();
const file = "public/index.html";
const accents = {
	blue: "#2563eb",
	green: "#10a37f",
	purple: "#7c3aed",
	orange: "#ea580c",
};

const accentMatch = request.match(/^(?:set|change) (?:the )?accent(?: color)? to (blue|green|purple|orange)[.!]?$/i);
const emptyMatch = request.match(/^set (?:the )?empty(?: |-)?state(?: message)? to ["“]?(.+?)["”]?[.!]?$/i);

let transform;

if (accentMatch) {
	const accent = accentMatch[1].toLowerCase();
	transform = {
		summary: `Accent set to ${accent}`,
		apply(source) {
			return source.replace(/--accent: #[0-9a-f]{6};/i, `--accent: ${accents[accent]};`);
		},
	};
} else if (emptyMatch) {
	const message = emptyMatch[1].trim();
	if (/^[A-Za-z0-9 ,.!?'’:-]{1,80}$/.test(message)) {
		transform = {
			summary: "Empty-state copy updated",
			apply(source) {
				return source.replace(/(<div class="empty" id="empty">)[^<]*(<\/div>)/, `$1${message}$2`);
			},
		};
	}
}

if (!transform) {
	console.log("AUTONOMY_DECISION=review");
	console.log("AUTONOMY_MESSAGE=This request is outside the allowlist for visual accent or empty-state copy changes.");
	process.exit(2);
}

const source = await readFile(file, "utf8");
const updated = transform.apply(source);
if (updated === source) throw new Error("The controlled transformation had no matching target.");
await writeFile(file, updated);
console.log("AUTONOMY_DECISION=apply");
console.log(`AUTONOMY_SUMMARY=${transform.summary}`);

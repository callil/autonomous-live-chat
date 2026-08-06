import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const demoEntry = "apps/demo/public/index.html";
const source = await readFile(demoEntry, "utf8");
if (!/--accent:\s*#[0-9a-f]{3,8}/iu.test(source)) throw new Error("The visual candidate does not define a valid accent token.");
if (!/prefers-reduced-motion/iu.test(source)) throw new Error("The visual candidate is missing its reduced-motion safeguard.");
if (process.env.APP_HARNESS_EXPECTED_BASE) {
	const head = process.env.APP_HARNESS_EXPECTED_HEAD ?? "HEAD";
	const files = execFileSync("git", ["diff", "--name-only", `${process.env.APP_HARNESS_EXPECTED_BASE}...${head}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	if (files.length !== 1 || files[0] !== demoEntry) throw new Error(`The visual CI profile permits only ${demoEntry} for this candidate.`);
	const changedLines = execFileSync("git", ["diff", "--unified=0", "--no-color", `${process.env.APP_HARNESS_EXPECTED_BASE}...${head}`, "--", demoEntry], { encoding: "utf8" })
		.split("\n")
		.filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")));
	if (changedLines.length !== 2 || !changedLines[0].startsWith("-") || !changedLines[1].startsWith("+")) {
		throw new Error("The accent visual profile permits exactly one replaced declaration.");
	}
	const accentDeclaration = /--accent:\s*#[0-9a-f]{3,8}/iu;
	if (!accentDeclaration.test(changedLines[0]) || !accentDeclaration.test(changedLines[1])) {
		throw new Error("The accent visual profile permits only an accent-token replacement.");
	}
}
console.log("Visual candidate static check passed");

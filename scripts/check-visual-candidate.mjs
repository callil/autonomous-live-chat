import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const source = await readFile("public/index.html", "utf8");
if (!/--accent:\s*#[0-9a-f]{3,8}/iu.test(source)) throw new Error("The visual candidate does not define a valid accent token.");
if (!/prefers-reduced-motion/iu.test(source)) throw new Error("The visual candidate is missing its reduced-motion safeguard.");
if (process.env.APP_HARNESS_EXPECTED_BASE) {
	const files = execFileSync("git", ["diff", "--name-only", `${process.env.APP_HARNESS_EXPECTED_BASE}...HEAD`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	if (files.length !== 1 || files[0] !== "public/index.html") throw new Error("The visual CI profile permits only public/index.html for this candidate.");
}
console.log("Visual candidate static check passed");

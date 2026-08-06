import { readFile } from "node:fs/promises";

const source = await readFile("public/index.html", "utf8");
if (!/--accent:\s*#[0-9a-f]{3,8}/iu.test(source)) throw new Error("The visual candidate does not define a valid accent token.");
if (!/prefers-reduced-motion/iu.test(source)) throw new Error("The visual candidate is missing its reduced-motion safeguard.");
console.log("Visual candidate static check passed");

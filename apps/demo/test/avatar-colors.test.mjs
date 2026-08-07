import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const script = await readFile(new URL("../public/avatar-colors.js", import.meta.url), "utf8");

class Element {}
class Document {
  querySelectorAll() {
    return [];
  }
}

const context = {
  Document,
  Element,
  document: new Document(),
  MutationObserver: class {
    observe() {}
  },
};
vm.runInNewContext(script, context);

const author = { textContent: "Ada Lovelace", style: {} };
const avatar = {
  style: {},
  closest: () => ({ querySelector: () => author }),
};
context.colorAvatar(avatar);

assert.match(avatar.style.color, /^hsl\(\d+ 70% 30%\)$/u, "the avatar receives a generated author color");
assert.equal(author.style.color, avatar.style.color, "the author's name matches their avatar color");

console.log("matching avatar and author colors passed");

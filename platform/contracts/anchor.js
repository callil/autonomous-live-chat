/**
 * ANCHORING for an app the harness knows nothing about.
 *
 * The overlay must identify "the thing the requester pointed at" in an
 * arbitrary third-party app: no build plugin, no framework assumption, no
 * knowledge of the app's class naming. Two tiers, best-effort first:
 *
 * 1. `data-loc="<file>:<line>"` when the app opted into the stamping plugin.
 *    Exact, and the agent gets a source line for free.
 * 2. A STRUCTURAL selector derived from the DOM itself, plus the captured
 *    subtree. Always available, never requires the app's cooperation.
 *
 * Tier 2 is the contract that matters: tier 1 is an optimization layered on
 * top. An overlay that only works in tier 1 is coupled to the app's build.
 */

/** Attributes that identify an element far more stably than its classes do. */
const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "data-component", "id", "name", "aria-label", "role"];
/** Depth of the ancestor chain in a structural selector: enough to disambiguate, bounded. */
const MAX_SELECTOR_DEPTH = 5;
/** Framework-generated class names (hashed CSS modules, utility soup) are noise, not identity. */
const UNSTABLE_CLASS = /^(?:[a-z]+-)?[a-f0-9]{5,}$|^css-|^sc-|^jsx-|^_[A-Za-z0-9]{4,}|^ng-|^svelte-/u;

function cssEscape(value) {
	// Deliberately conservative: anything outside this set is rejected rather
	// than escaped, so a selector we emit is always one we can also parse.
	return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value) ? value : null;
}

/** The classes worth putting in a selector: author-written, not build-generated. */
export function stableClasses(element) {
	const list = typeof element?.className === "string" ? element.className.trim().split(/\s+/u) : [];
	return list.filter((name) => name && !UNSTABLE_CLASS.test(name) && cssEscape(name) !== null).slice(0, 3);
}

/** The most identifying attribute available on one element, or null. */
export function stableAttribute(element) {
	for (const name of STABLE_ATTRIBUTES) {
		const value = element?.getAttribute?.(name);
		// A framework-generated id is as useless as a hashed class.
		if (typeof value === "string" && value.length > 0 && value.length <= 120 && !UNSTABLE_CLASS.test(value)) {
			return { name, value };
		}
	}
	return null;
}

/** One element's own selector segment, most specific signal first. */
function segmentFor(element) {
	const tag = String(element.tagName || "").toLowerCase();
	if (!tag) return null;
	const attribute = stableAttribute(element);
	if (attribute) {
		if (attribute.name === "id" && cssEscape(attribute.value)) return `#${attribute.value}`;
		return `${tag}[${attribute.name}="${attribute.value.replaceAll('"', '\\"')}"]`;
	}
	const classes = stableClasses(element);
	if (classes.length) return `${tag}.${classes.join(".")}`;
	return tag;
}

/** Where this element sits among same-tag siblings — the disambiguator of last resort. */
function nthOfType(element) {
	const parent = element.parentElement;
	if (!parent) return null;
	const sameTag = [...parent.children].filter((child) => child.tagName === element.tagName);
	if (sameTag.length < 2) return null;
	return sameTag.indexOf(element) + 1;
}

/**
 * Build a structural selector for an element in an unknown app, walking up
 * until the selector is unique in the document (or the depth budget is spent).
 * Returns the selector plus whether it was verified unique — the overlay
 * reports that honestly rather than implying precision it does not have.
 */
export function structuralSelector(element, doc) {
	if (!element || !element.tagName) return null;
	const parts = [];
	let current = element;
	for (let depth = 0; depth < MAX_SELECTOR_DEPTH && current && current.tagName; depth += 1) {
		let segment = segmentFor(current);
		if (!segment) break;
		if (depth === 0) {
			const index = nthOfType(current);
			if (index !== null && !segment.startsWith("#")) segment = `${segment}:nth-of-type(${index})`;
		}
		parts.unshift(segment);
		const selector = parts.join(" > ");
		// An id is unique by definition; otherwise ask the document.
		if (segment.startsWith("#")) return { selector, unique: true, depth: depth + 1 };
		let matches = null;
		try { matches = doc?.querySelectorAll?.(selector) ?? null; } catch { matches = null; }
		if (matches && matches.length === 1) return { selector, unique: true, depth: depth + 1 };
		current = current.parentElement;
	}
	if (!parts.length) return null;
	const selector = parts.join(" > ");
	let unique = false;
	try { unique = doc?.querySelectorAll?.(selector)?.length === 1; } catch { unique = false; }
	return { selector, unique, depth: parts.length };
}

/**
 * A human-readable label for what was pointed at, for the composer's context
 * line. Prefers the app's own words (a test id, a label, visible text) over a
 * selector, because that is what the requester recognizes.
 */
export function describeTarget(element) {
	const attribute = stableAttribute(element);
	if (attribute && attribute.name !== "role") return `${attribute.name}="${attribute.value}"`;
	const text = typeof element?.textContent === "string" ? element.textContent.trim().replaceAll(/\s+/gu, " ") : "";
	if (text) return `“${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`;
	return String(element?.tagName || "element").toLowerCase();
}

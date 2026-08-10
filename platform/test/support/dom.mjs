/**
 * A DOM stand-in for BOOT TESTS — the layer that catches what source greps cannot.
 *
 * Every overlay test in this repo was once a source grep, and all of them passed
 * while the shipped overlay threw `ReferenceError: Cannot access 'dockEl' before
 * initialization` on load: the WebSocket never opened and the room was inert.
 * A grep can prove a string is present. Only EXECUTION can prove the script runs.
 *
 * This harness is deliberately small and dependency-free (no jsdom): the client
 * scripts here are plain DOM scripts, and a stub that implements the handful of
 * APIs they actually touch is faster, has no install cost in CI, and — crucially
 * — fails loudly on anything it does NOT implement, instead of silently
 * absorbing a call the way a permissive mock would.
 *
 * What it models, because the invariants depend on it:
 *  - a real element TREE (parents, children, append/remove), so measurement and
 *    traversal see the same shape the browser would
 *  - LAYOUT boxes, assignable per element, so hit-testing and inset measurement
 *    are computed rather than asserted
 *  - EVENT dispatch with listeners, so a control can actually be "clicked"
 *  - `elementFromPoint`, so "is the send control hittable?" is answered by
 *    geometry and pointer-events, not by reading CSS text
 *  - shadow roots, including CLOSED ones, since that is how the overlay isolates
 *
 * Anything a script touches that is not modelled throws, and every boot test
 * asserts no error was logged, so an unimplemented API surfaces as a test
 * failure rather than a false green.
 */

/** A CSS style declaration that records what was set, including custom properties. */
function makeStyle() {
	const properties = new Map();
	return {
		cssText: "",
		properties,
		setProperty(name, value) {
			properties.set(name, String(value));
		},
		getPropertyValue: (name) => properties.get(name) ?? "",
		removeProperty(name) {
			properties.delete(name);
		},
	};
}

let nextId = 0;

/** Attributes whose IDL property page scripts read directly (`meta.content`, `a.href`). */
const REFLECTED_ATTRIBUTES = new Set(["content", "href", "src", "type", "name", "id", "placeholder", "title", "rel", "role"]);

/**
 * One element. `rect` is settable so a test can give the tree a real layout;
 * `pointerEvents` participates in hit-testing exactly as the browser's does.
 */
export class StubElement {
	constructor(tagName = "DIV", ownerDocument = null) {
		this.tagName = String(tagName).toUpperCase();
		this.ownerDocument = ownerDocument;
		this.uid = (nextId += 1);
		this.children = [];
		this.parentElement = null;
		this.attributes = new Map();
		this.style = makeStyle();
		this.dataset = {};
		this.listeners = new Map();
		this.hidden = false;
		this.disabled = false;
		this.value = "";
		this.textContent = "";
		this.innerHTML = "";
		this.className = "";
		this.shadowRoot = null;
		this.pointerEvents = null;
		this.rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
		this.classList = {
			add: (...names) => this.#editClasses((set) => names.forEach((n) => set.add(n))),
			remove: (...names) => this.#editClasses((set) => names.forEach((n) => set.delete(n))),
			toggle: (name, force) =>
				this.#editClasses((set) => {
					const on = force === undefined ? !set.has(name) : force;
					if (on) set.add(name);
					else set.delete(name);
				}),
			contains: (name) => this.classNames().includes(name),
		};
	}

	#editClasses(mutate) {
		const set = new Set(this.classNames());
		mutate(set);
		this.className = [...set].join(" ");
	}

	classNames() {
		return this.className.trim().split(/\s+/u).filter(Boolean);
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
		if (name === "class") this.className = String(value);
		// Reflect the IDL properties page scripts actually read. Without this a
		// script doing `meta.content` silently sees undefined and the test would
		// be measuring the stub instead of the page.
		if (REFLECTED_ATTRIBUTES.has(name)) this[name] = String(value);
	}

	getAttribute(name) {
		if (name === "class") return this.className || null;
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	hasAttribute(name) {
		return this.attributes.has(name);
	}

	append(...nodes) {
		for (const node of nodes) {
			if (!node || typeof node !== "object") continue;
			node.parentElement?.remove?.call(node.parentElement, node);
			node.parentElement = this;
			this.children.push(node);
		}
	}

	appendChild(node) {
		this.append(node);
		return node;
	}

	replaceChildren(...nodes) {
		for (const child of this.children) child.parentElement = null;
		this.children = [];
		this.append(...nodes);
	}

	remove(node) {
		if (node === undefined) {
			this.parentElement?.remove(this);
			return;
		}
		const index = this.children.indexOf(node);
		if (index !== -1) {
			this.children.splice(index, 1);
			node.parentElement = null;
		}
	}

	removeChild(node) {
		this.remove(node);
		return node;
	}

	get firstChild() {
		return this.children[0] ?? null;
	}

	get lastElementChild() {
		return this.children.at(-1) ?? null;
	}

	getBoundingClientRect() {
		return { ...this.rect };
	}

	/** Give this element a layout box; right/bottom are derived. */
	setRect({ left = 0, top = 0, width = 0, height = 0 }) {
		this.rect = { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
		return this;
	}

	attachShadow({ mode }) {
		const root = new StubShadowRoot(this, mode, this.ownerDocument);
		// A CLOSED root is exactly what the overlay uses, and the point of it is
		// that the page cannot reach it. Model that honestly: expose it on the
		// harness side only, so a test can inspect it while page code cannot.
		if (mode === "open") this.shadowRoot = root;
		this.closedShadowRoot = root;
		return root;
	}

	addEventListener(type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(handler);
	}

	removeEventListener(type, handler) {
		const list = this.listeners.get(type);
		if (list) this.listeners.set(type, list.filter((entry) => entry !== handler));
	}

	/** Fire a listener set; bubbles to the parent unless the handler stops it. */
	dispatchEvent(event) {
		const target = event.target ?? this;
		let node = this;
		let stopped = false;
		event.target = target;
		event.preventDefault = () => {
			event.defaultPrevented = true;
		};
		event.stopPropagation = () => {
			stopped = true;
		};
		while (node && !stopped) {
			event.currentTarget = node;
			for (const handler of [...(node.listeners.get(event.type) ?? [])]) handler.call(node, event);
			node = node.parentElement;
		}
		return !event.defaultPrevented;
	}

	/** Descendants in document order, this element first. */
	descendants() {
		const out = [this];
		for (const child of this.children) out.push(...(child.descendants?.() ?? [child]));
		return out;
	}

	querySelector(selector) {
		return matchTree(this, selector)[0] ?? null;
	}

	querySelectorAll(selector) {
		return matchTree(this, selector);
	}

	requestSubmit() {
		this.dispatchEvent({ type: "submit" });
	}

	focus() {
		this.focused = true;
	}

	scrollIntoView() {}

	closest(selector) {
		let node = this;
		while (node) {
			if (matchesSelector(node, selector)) return node;
			node = node.parentElement;
		}
		return null;
	}
}

/** Supports the selector shapes these clients actually use: #id, .class, tag, [attr], and tag[attr=v]. */
function matchesSelector(element, selector) {
	const trimmed = selector.trim();
	if (!trimmed) return false;
	for (const part of trimmed.split(",").map((s) => s.trim())) {
		// Take only the rightmost compound of a descendant selector; the clients
		// under test never rely on ancestor constraints for their own lookups.
		const compound = part.split(/\s+/u).at(-1);
		const attribute = /^([a-zA-Z]*)\[([a-zA-Z-]+)(?:=["']?([^"'\]]*)["']?)?\]$/u.exec(compound);
		if (attribute) {
			const [, tag, name, value] = attribute;
			if (tag && element.tagName !== tag.toUpperCase()) continue;
			if (!element.hasAttribute(name) && !(name === "hidden" && element.hidden)) continue;
			if (value !== undefined && element.getAttribute(name) !== value) continue;
			return true;
		}
		if (compound.startsWith("#")) {
			if (element.getAttribute("id") === compound.slice(1)) return true;
			continue;
		}
		if (compound.startsWith(".")) {
			if (compound.slice(1).split(".").every((name) => element.classNames().includes(name))) return true;
			continue;
		}
		const [tag, ...classes] = compound.split(".");
		if (tag && element.tagName !== tag.toUpperCase()) continue;
		if (classes.length && !classes.every((name) => element.classNames().includes(name))) continue;
		return true;
	}
	return false;
}

function matchTree(rootNode, selector) {
	const all = rootNode.descendants ? rootNode.descendants().slice(1) : [];
	return all.filter((element) => matchesSelector(element, selector));
}

export class StubShadowRoot {
	constructor(host, mode, ownerDocument) {
		this.host = host;
		this.mode = mode;
		this.ownerDocument = ownerDocument;
		this.children = [];
		this.parentElement = null;
		this.tagName = "";
		this.listeners = new Map();
		this.#html = "";
	}

	#html;

	/**
	 * Parsing the overlay's real template is what makes "the control exists and
	 * is hittable" a behavioral claim rather than a string search: the ids and
	 * the tree come from the shipped markup, whatever it says.
	 */
	set innerHTML(markup) {
		this.#html = markup;
		for (const child of this.children) child.parentElement = null;
		this.children = [];
		this.append(...parseFragment(markup, this.ownerDocument));
	}

	get innerHTML() {
		return this.#html;
	}

	append(...nodes) {
		StubElement.prototype.append.call(this, ...nodes);
	}

	descendants() {
		const out = [];
		for (const child of this.children) out.push(...(child.descendants?.() ?? [child]));
		return out;
	}

	getElementById(id) {
		return this.descendants().find((element) => element.getAttribute("id") === id) ?? null;
	}

	querySelector(selector) {
		return this.descendants().find((element) => matchesSelector(element, selector)) ?? null;
	}

	querySelectorAll(selector) {
		return this.descendants().filter((element) => matchesSelector(element, selector));
	}

	addEventListener(type, handler) {
		StubElement.prototype.addEventListener.call(this, type, handler);
	}

	dispatchEvent(event) {
		return StubElement.prototype.dispatchEvent.call(this, event);
	}
}

/**
 * A small HTML fragment parser: enough for the overlay's template and the room
 * shell. It records tag, attributes (including id/class/hidden) and nesting —
 * everything the boot invariants query — and ignores the rest.
 */
export function parseFragment(markup, ownerDocument = null) {
	const roots = [];
	const stack = [];
	const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
	// Style and script bodies must not be parsed as markup.
	const stripped = markup.replaceAll(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/giu, "");
	const tokens = stripped.matchAll(/<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)(\/)?>|([^<]+)/gu);
	for (const token of tokens) {
		const [, closing, tagName, attributeText, selfClosing, text] = token;
		if (text !== undefined) {
			const parent = stack.at(-1);
			if (parent && text.trim()) parent.textContent = `${parent.textContent}${text}`.trim();
			continue;
		}
		if (closing) {
			while (stack.length && stack.at(-1).tagName !== tagName.toUpperCase()) stack.pop();
			stack.pop();
			continue;
		}
		const element = new StubElement(tagName, ownerDocument);
		for (const attribute of attributeText.matchAll(/([a-zA-Z-]+)(?:=["']([^"']*)["'])?/gu)) {
			const [, name, value] = attribute;
			element.setAttribute(name, value ?? "");
			if (name === "hidden") element.hidden = true;
			if (name.startsWith("data-")) {
				const key = name.slice(5).replaceAll(/-([a-z])/gu, (_, c) => c.toUpperCase());
				element.dataset[key] = value ?? "";
			}
		}
		const parent = stack.at(-1);
		if (parent) parent.append(element);
		else roots.push(element);
		if (!selfClosing && !voidTags.has(tagName.toLowerCase())) stack.push(element);
	}
	return roots;
}

/**
 * Build a window/document sandbox for executing a client script.
 *
 * Returns the sandbox plus the recorded side effects the boot invariants care
 * about: console errors, sockets opened, fetches issued, scheduled frames.
 */
export function createSandbox({ html = "", scriptDataset = {}, viewport = { width: 1280, height: 720 }, location: locationOverrides = {} } = {}) {
	const consoleErrors = [];
	const sockets = [];
	const fetches = [];
	const frames = [];
	const timers = [];
	const observers = [];
	const rootStyle = makeStyle();

	const document = {};
	const body = new StubElement("BODY", document);
	const documentElement = new StubElement("HTML", document);
	documentElement.style = rootStyle;
	const head = new StubElement("HEAD", document);
	documentElement.append(head, body);

	for (const node of parseFragment(html, document)) {
		if (node.tagName === "HTML") {
			for (const child of [...node.children]) {
				if (child.tagName === "BODY") body.append(...[...child.children]);
				else if (child.tagName === "HEAD") head.append(...[...child.children]);
			}
		} else if (node.tagName === "BODY") {
			body.append(...[...node.children]);
		} else {
			body.append(node);
		}
	}

	const currentScript = new StubElement("SCRIPT", document);
	currentScript.dataset = { ...scriptDataset };

	/** All elements in the light DOM, deepest last — hit-testing walks this. */
	const lightTree = () => documentElement.descendants();

	Object.assign(document, {
		documentElement,
		body,
		head,
		currentScript,
		hidden: false,
		listeners: new Map(),
		createElement: (tag) => new StubElement(tag, document),
		createElementNS: (_ns, tag) => new StubElement(tag, document),
		createTextNode: (text) => {
			const node = new StubElement("#text", document);
			node.textContent = text;
			return node;
		},
		getElementById: (id) => lightTree().find((element) => element.getAttribute("id") === id) ?? null,
		querySelector: (selector) => lightTree().find((element) => matchesSelector(element, selector)) ?? null,
		querySelectorAll: (selector) => lightTree().filter((element) => matchesSelector(element, selector)),
		addEventListener(type, handler) {
			if (!document.listeners.has(type)) document.listeners.set(type, []);
			document.listeners.get(type).push(handler);
		},
		removeEventListener() {},
		dispatchEvent: (event) => {
			for (const handler of [...(document.listeners.get(event.type) ?? [])]) handler(event);
			return true;
		},
		/**
		 * Real geometric hit-testing: the topmost element whose box contains the
		 * point and which is not pointer-transparent. This is how a boot test can
		 * assert a control is reachable by a user's click instead of asserting
		 * that some CSS file contains a string.
		 */
		elementFromPoint(x, y) {
			let hit = null;
			for (const element of lightTree()) {
				if (element.hidden) continue;
				const { left, top, width, height } = element.rect;
				if (width <= 0 || height <= 0) continue;
				if (x < left || x > left + width || y < top || y > top + height) continue;
				if (effectivePointerEvents(element) === "none") continue;
				hit = element;
			}
			return hit;
		},
	});

	const sandbox = {
		document,
		innerWidth: viewport.width,
		innerHeight: viewport.height,
		devicePixelRatio: 1,
		location: {
			pathname: "/",
			protocol: "https:",
			host: "app.test",
			hostname: "app.test",
			origin: "https://app.test",
			href: "https://app.test/",
			replace() {},
			reload() {},
			...locationOverrides,
		},
		navigator: { userAgent: "boot-test" },
		console: {
			error: (...args) => consoleErrors.push(args.map(String).join(" ")),
			warn: () => {},
			log: () => {},
			info: () => {},
			debug: () => {},
		},
		requestAnimationFrame: (fn) => {
			frames.push(fn);
			return frames.length;
		},
		cancelAnimationFrame: () => {},
		setTimeout: (fn, ms) => {
			timers.push({ fn, ms });
			return timers.length;
		},
		clearTimeout: () => {},
		setInterval: (fn, ms) => {
			timers.push({ fn, ms, repeating: true });
			return timers.length;
		},
		clearInterval: () => {},
		queueMicrotask: (fn) => fn(),
		getComputedStyle: (element) => ({
			getPropertyValue: (name) => element?.style?.getPropertyValue?.(name) ?? "",
			pointerEvents: element?.pointerEvents ?? "auto",
		}),
		crypto: { randomUUID: () => `uuid-${nextId += 1}` },
		URL,
		URLSearchParams,
		Event: class {
			constructor(type, init = {}) {
				Object.assign(this, { type, ...init });
			}
		},
		CustomEvent: class {
			constructor(type, init = {}) {
				Object.assign(this, { type, ...init });
			}
		},
		ResizeObserver: class {
			constructor(callback) {
				this.callback = callback;
				this.observed = [];
				observers.push(this);
			}
			observe(target) {
				this.observed.push(target);
			}
			unobserve() {}
			disconnect() {}
		},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		IntersectionObserver: class {
			observe() {}
			disconnect() {}
		},
		WebSocket: class {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			constructor(url) {
				this.url = url;
				this.readyState = 0;
				this.sent = [];
				this.listeners = new Map();
				sockets.push(this);
			}
			addEventListener(type, handler) {
				if (!this.listeners.has(type)) this.listeners.set(type, []);
				this.listeners.get(type).push(handler);
			}
			removeEventListener() {}
			send(data) {
				this.sent.push(data);
			}
			close() {
				this.readyState = 3;
				this.emit("close", {});
			}
			/** Drive the socket from a test: open it, or deliver a server frame. */
			emit(type, event) {
				if (type === "open") this.readyState = 1;
				for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
			}
			deliver(payload) {
				this.emit("message", { data: JSON.stringify(payload) });
			}
		},
		fetch: (input, init) => {
			const request = { url: String(input), init };
			let settle;
			const promise = new Promise((resolve) => {
				settle = resolve;
			});
			request.respond = (response) => settle(response);
			fetches.push(request);
			return promise;
		},
		localStorage: {
			store: new Map(),
			getItem(key) {
				return this.store.get(key) ?? null;
			},
			setItem(key, value) {
				this.store.set(key, String(value));
			},
			removeItem(key) {
				this.store.delete(key);
			},
		},
		listeners: new Map(),
		addEventListener(type, handler) {
			if (!sandbox.listeners.has(type)) sandbox.listeners.set(type, []);
			sandbox.listeners.get(type).push(handler);
		},
		removeEventListener() {},
		dispatchEvent: (event) => {
			for (const handler of [...(sandbox.listeners.get(event.type) ?? [])]) handler(event);
			return true;
		},
		Date,
		Math,
		JSON,
		Intl,
		Promise,
		Set,
		Map,
		Array,
		Object,
		String,
		Number,
		Boolean,
		Error,
		RegExp,
		isNaN,
		parseInt,
		parseFloat,
		encodeURIComponent,
		decodeURIComponent,
	};

	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;
	sandbox.top = sandbox;
	sandbox.parent = sandbox;

	return {
		sandbox,
		document,
		body,
		documentElement,
		rootStyle,
		consoleErrors,
		sockets,
		fetches,
		frames,
		timers,
		observers,
		/** Run every animation frame callback queued so far. */
		flushFrames() {
			const queued = frames.splice(0, frames.length);
			for (const fn of queued) fn();
			return queued.length;
		},
		/** Run non-repeating timers whose delay is at or below `maxMs`. */
		flushTimers(maxMs = Infinity) {
			const due = timers.filter((timer) => !timer.repeating && timer.ms <= maxMs);
			timers.length = 0;
			for (const timer of due) timer.fn();
			return due.length;
		},
	};
}

/** An element is click-through if it or any ancestor sets pointer-events:none without a descendant opting back in. */
function effectivePointerEvents(element) {
	let node = element;
	while (node) {
		if (node.pointerEvents === "auto") return "auto";
		if (node.pointerEvents === "none") return "none";
		node = node.parentElement;
	}
	return "auto";
}

/**
 * Execute a client script inside a sandbox. The script is a plain browser
 * script, so it is run as a function body with the sandbox globals in scope —
 * which means a load-time throw (a temporal-dead-zone ReferenceError, a typo, a
 * missing guard) propagates to the caller and fails the test.
 */
export function runScript(source, sandbox) {
	const keys = Object.keys(sandbox);
	const run = new Function(...keys, `"use strict";\n${source}`);
	return run(...keys.map((key) => sandbox[key]));
}

/** Apply CSS `pointer-events` declarations from a stylesheet to a parsed tree. */
export function applyPointerEvents(css, elements) {
	for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
		const [, selectorList, body] = rule;
		const declaration = /(?:^|;)\s*pointer-events\s*:\s*([a-z-]+)/iu.exec(body);
		if (!declaration) continue;
		for (const selector of selectorList.split(",").map((s) => s.trim())) {
			for (const element of elements) {
				if (matchesSelector(element, selector)) element.pointerEvents = declaration[1];
			}
		}
	}
}

export { matchesSelector };

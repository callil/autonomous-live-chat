/**
 * The TENANT contract: what `npx app-harness init` asks an app owner, frozen
 * as data.
 *
 * App Harness attaches to an app it knows nothing about. Everything that is
 * specific to a particular installed app lives HERE, as configuration — never
 * as code in the overlay, the platform, or the runner. `product/` in this
 * repository is one tenant (the example chat room that ships with the
 * harness); a third-party app installed via the CLI is another. Neither is
 * privileged.
 *
 * The overlay reads only `anchor` and `surface`. The runner reads only
 * `repository`. Nothing reads the app's source, framework, or bundle.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REPO_RELATIVE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,191}$/u;
/** A shell word list, not a shell string: no interpolation, no operators, no quoting rules. */
const COMMAND_WORD = /^[A-Za-z0-9._:/@=-]{1,120}$/u;

/**
 * How the overlay identifies the element a requester pointed at.
 *
 * - "data-loc": the app opted into the build-time stamping plugin, so every
 *   element carries `data-loc="<file>:<line>"` and the agent gets an exact
 *   source line. An optimization, never a requirement.
 * - "structural": no build cooperation at all. The overlay derives a stable
 *   structural selector plus the captured DOM subtree, and the agent locates
 *   the source itself. This is the DEFAULT because it is the only mode that
 *   works for an arbitrary third-party app.
 */
export const ANCHOR_MODES = ["structural", "data-loc"];

/** The default tenant shape: what an app gets before answering any question. */
export const TENANT_DEFAULTS = Object.freeze({
	anchorMode: "structural",
	testCommand: [],
	deployCommand: [],
	frameworkHint: null,
});

function slug(value, label) {
	if (typeof value !== "string" || !SLUG.test(value)) throw new Error(`${label} must be a lowercase slug.`);
	return value;
}

function commandWords(value, label) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be an argv array, not a shell string.`);
	if (value.length > 24) throw new Error(`${label} is too long.`);
	for (const word of value) {
		if (typeof word !== "string" || !COMMAND_WORD.test(word)) throw new Error(`${label} contains an unsafe argument.`);
	}
	return [...value];
}

/**
 * Validate one tenant descriptor. Throws loudly rather than guessing: a
 * misconfigured tenant must fail at install time, not silently target the
 * wrong repository path at build time.
 */
export function defineTenant(input) {
	if (!input || typeof input !== "object") throw new Error("A tenant descriptor must be an object.");
	const { id, repository, sourceRoot, anchorMode, testCommand, deployCommand, frameworkHint } = input;
	if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
		throw new Error("Tenant repository must be owner/name.");
	}
	if (typeof sourceRoot !== "string" || !REPO_RELATIVE.test(sourceRoot) || sourceRoot.includes("..")) {
		throw new Error("Tenant sourceRoot must be a repository-relative path.");
	}
	const mode = anchorMode ?? TENANT_DEFAULTS.anchorMode;
	if (!ANCHOR_MODES.includes(mode)) throw new Error(`Tenant anchorMode must be one of: ${ANCHOR_MODES.join(", ")}.`);
	if (frameworkHint !== undefined && frameworkHint !== null && (typeof frameworkHint !== "string" || frameworkHint.length > 64)) {
		throw new Error("Tenant frameworkHint must be a short string.");
	}
	return Object.freeze({
		id: slug(id, "Tenant id"),
		repository,
		/** The ONLY tree the agent may write. The firewall is the enforcement; this is the intent. */
		sourceRoot: sourceRoot.replace(/\/+$/u, ""),
		anchorMode: mode,
		testCommand: commandWords(testCommand, "Tenant testCommand"),
		deployCommand: commandWords(deployCommand, "Tenant deployCommand"),
		frameworkHint: frameworkHint ?? null,
	});
}

/**
 * The tenant installed in THIS repository: the example chat room. It is an
 * ordinary tenant that happens to ship in-tree — the harness has no other
 * knowledge of it. Replacing this descriptor is what installing App Harness
 * against a different app means.
 */
export const INSTALLED_TENANT = defineTenant({
	id: "example-room",
	repository: "callil/autonomous-live-chat",
	sourceRoot: "product",
	// This tenant DID opt into the stamping plugin, so anchors carry exact
	// source lines. An app that has not opted in gets "structural" and works.
	anchorMode: "data-loc",
	testCommand: ["node", "product/test/ui-contract.test.mjs"],
	frameworkHint: "vanilla",
});

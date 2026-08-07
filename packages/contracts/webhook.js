/**
 * Pure GitHub webhook fact contracts shared by the bridge receiver and the
 * ledger ingest. A webhook delivery never writes work-item state: it is
 * filtered down to one immutable fact, matched to at most one live work item
 * by an identity the ledger already owns (candidate head revision, promotion
 * dispatch key, plan branch), and merged monotonically into the per-item
 * external-fact record the operator wake snapshot embeds.
 */

const SHA = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u;

export const GITHUB_CANDIDATE_WORKFLOW_PATH = ".github/workflows/os-stack-ci.yml";
export const GITHUB_PROMOTION_WORKFLOW_PATH = ".github/workflows/os-stack-promote.yml";
export const GITHUB_CANDIDATE_BRANCH_PREFIX = "app-harness-os/";
/** Must match the `run-name` interpolation in os-stack-promote.yml. */
export const GITHUB_PROMOTION_RUN_PREFIX = "App Harness promotion · ";
export const GITHUB_DELIVERY_MARKER_PREFIX = "github-delivery:";
export const GITHUB_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The X-GitHub-Delivery GUID is stable across redeliveries: it is the transport dedupe key. */
export function normalizeGithubDeliveryId(value) {
	return typeof value === "string" && DELIVERY_ID.test(value) ? value : null;
}

export function githubDeliveryMarkerKey(deliveryId) {
	return `${GITHUB_DELIVERY_MARKER_PREFIX}${deliveryId}`;
}

export function expiredGithubDeliveryMarker(marker, now) {
	return !marker || typeof marker.at !== "number" || marker.at + GITHUB_DELIVERY_RETENTION_MS <= now;
}

function githubHtmlUrl(value) {
	if (typeof value !== "string") return null;
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
}

/** Shared workflow_run field validation for validation and promotion facts. */
function workflowRunBase(run) {
	if (!run || typeof run !== "object") return null;
	const url = githubHtmlUrl(run.html_url);
	if (!Number.isSafeInteger(run.id) || run.id < 1 || !url) return null;
	if (run.conclusion !== null && typeof run.conclusion !== "string") return null;
	if (typeof run.created_at !== "string" || !Number.isFinite(Date.parse(run.created_at))) return null;
	return { runId: run.id, url, conclusion: run.conclusion, createdAt: run.created_at };
}

/**
 * Filter one GitHub webhook delivery down to the single App Harness fact it
 * carries, or null when the event is outside the push contract. The caller
 * has already verified the signature and the repository gate.
 */
export function extractGithubWebhookFact({ event, payload }) {
	if (!payload || typeof payload !== "object") return null;
	if (event === "workflow_run") {
		if (payload.action !== "completed") return null;
		const run = payload.workflow_run;
		if (!run || typeof run !== "object" || typeof run.path !== "string") return null;
		const base = workflowRunBase(run);
		if (!base) return null;
		if (run.path.startsWith(GITHUB_CANDIDATE_WORKFLOW_PATH)) {
			// The candidate CI run is matched later by its immutable head
			// revision: GitHub does not reliably render the workflow run-name
			// interpolation into display_title.
			if (run.event !== "pull_request_target") return null;
			if (typeof run.head_branch !== "string" || !run.head_branch.startsWith(GITHUB_CANDIDATE_BRANCH_PREFIX)) return null;
			if (typeof run.head_sha !== "string" || !SHA.test(run.head_sha)) return null;
			return { kind: "validation", ...base, headSha: run.head_sha };
		}
		if (run.path.startsWith(GITHUB_PROMOTION_WORKFLOW_PATH)) {
			// The promotion run-name is a deterministic function of the durable
			// dispatch key, so the display title is the promotion identity.
			if (run.event !== "workflow_dispatch") return null;
			if (typeof run.display_title !== "string" || !run.display_title.startsWith(GITHUB_PROMOTION_RUN_PREFIX)) return null;
			const dispatchKey = run.display_title.slice(GITHUB_PROMOTION_RUN_PREFIX.length);
			if (!IDENTIFIER.test(dispatchKey)) return null;
			return { kind: "promotion", ...base, dispatchKey };
		}
		return null;
	}
	if (event === "pull_request") {
		// A wake accelerator plus corroborating fact only: the runner's own
		// completion callback stays the authoritative candidate path because it
		// alone carries the active run's bearer credential and reports failure.
		if (payload.action !== "opened") return null;
		const pull = payload.pull_request;
		if (!pull || typeof pull !== "object" || !pull.head || typeof pull.head !== "object") return null;
		const url = githubHtmlUrl(pull.html_url);
		if (!Number.isSafeInteger(pull.number) || pull.number < 1 || !url) return null;
		if (typeof pull.head.ref !== "string" || !pull.head.ref.startsWith(GITHUB_CANDIDATE_BRANCH_PREFIX)) return null;
		if (typeof pull.head.sha !== "string" || !SHA.test(pull.head.sha)) return null;
		return { kind: "candidate", number: pull.number, url, headSha: pull.head.sha, branch: pull.head.ref };
	}
	return null;
}

/** Re-validate a fact that crossed the bridge->ledger service boundary. */
export function normalizeGithubWebhookFact(value) {
	if (!value || typeof value !== "object") return null;
	if (value.kind === "validation" || value.kind === "promotion") {
		const base = workflowRunBase({ id: value.runId, html_url: value.url, conclusion: value.conclusion, created_at: value.createdAt });
		if (!base) return null;
		if (value.kind === "validation") {
			return typeof value.headSha === "string" && SHA.test(value.headSha) ? { kind: "validation", ...base, headSha: value.headSha } : null;
		}
		return typeof value.dispatchKey === "string" && IDENTIFIER.test(value.dispatchKey) ? { kind: "promotion", ...base, dispatchKey: value.dispatchKey } : null;
	}
	if (value.kind === "candidate") {
		const url = githubHtmlUrl(value.url);
		if (!Number.isSafeInteger(value.number) || value.number < 1 || !url) return null;
		if (typeof value.branch !== "string" || !value.branch.startsWith(GITHUB_CANDIDATE_BRANCH_PREFIX)) return null;
		if (typeof value.headSha !== "string" || !SHA.test(value.headSha)) return null;
		return { kind: "candidate", number: value.number, url, headSha: value.headSha, branch: value.branch };
	}
	return null;
}

/**
 * Match a fact to at most one live work item using immutable identities the
 * ledger already recorded. Restacks are safe for free: a revised plan deletes
 * candidate/validation artifacts, so an old-generation head revision no longer
 * matches anything and the event drops on the floor.
 */
export function matchGithubFactToWorkItem(fact, items, promotions = []) {
	const ordered = [...items].toSorted((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
	if (fact.kind === "validation") {
		return ordered.find((item) => item.artifacts?.candidate?.headSha === fact.headSha)?.id ?? null;
	}
	if (fact.kind === "promotion") {
		const live = new Set(ordered.map((item) => item.id));
		return promotions.find((entry) => entry.dispatchKey === fact.dispatchKey && live.has(entry.workItemId))?.workItemId ?? null;
	}
	if (fact.kind === "candidate") {
		return ordered.find((item) => item.plan?.branch === fact.branch)?.id ?? null;
	}
	return null;
}

/**
 * Monotonic merge into the per-item external-fact record. Returns the merged
 * record, or null when the delivery adds nothing: a duplicate, an older run,
 * or a null conclusion after a recorded one — evidence is never downgraded.
 */
export function mergeGithubFact(existing, fact, now) {
	const facts = existing && typeof existing === "object" ? existing : {};
	if (fact.kind === "validation" || fact.kind === "promotion") {
		const current = facts[fact.kind];
		if (current) {
			if (current.runId === fact.runId) {
				// Same run: only a new non-null conclusion is new evidence.
				if (fact.conclusion === null || current.conclusion === fact.conclusion) return null;
			} else if (Date.parse(fact.createdAt) <= Date.parse(current.createdAt)) {
				// An older run never replaces newer recorded evidence.
				return null;
			}
		}
		const merged = { runId: fact.runId, url: fact.url, conclusion: fact.conclusion, createdAt: fact.createdAt, at: now };
		if (fact.kind === "validation") merged.headSha = fact.headSha;
		else merged.dispatchKey = fact.dispatchKey;
		return { ...facts, [fact.kind]: merged };
	}
	if (fact.kind === "candidate") {
		if (facts.candidate && facts.candidate.headSha === fact.headSha) return null;
		return { ...facts, candidate: { number: fact.number, url: fact.url, headSha: fact.headSha, branch: fact.branch, at: now } };
	}
	return null;
}

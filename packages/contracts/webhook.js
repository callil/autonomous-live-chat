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
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;

function safeBaseBranch(value) {
	return typeof value === "string" && BRANCH.test(value) && !value.includes("..") && !value.endsWith("/") && !value.startsWith("-") ? value : null;
}

export const GITHUB_CANDIDATE_WORKFLOW_PATH = ".github/workflows/os-stack-ci.yml";
export const GITHUB_PROMOTION_WORKFLOW_PATH = ".github/workflows/os-stack-promote.yml";
export const GITHUB_MAIN_DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy-demo-on-main.yml";
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

/**
 * Parse the durable dispatch key out of a promotion run's rendered run-name.
 * Returns null when the title is not the deterministic promotion name — which
 * includes GitHub's known failure to render the run-name interpolation into
 * webhook payloads' display_title even for runs whose UI title renders fine.
 */
export function parsePromotionDispatchKey(displayTitle) {
	if (typeof displayTitle !== "string" || !displayTitle.startsWith(GITHUB_PROMOTION_RUN_PREFIX)) return null;
	const dispatchKey = displayTitle.slice(GITHUB_PROMOTION_RUN_PREFIX.length);
	return IDENTIFIER.test(dispatchKey) ? dispatchKey : null;
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
			// dispatch key, but GitHub does not reliably render the run-name
			// interpolation into the webhook payload's display_title (the same
			// unreliability that moved candidate validation to head_sha matching).
			// The payload carries no other promotion identity — no inputs, and
			// head_sha is main's tip at dispatch, which the ledger never recorded —
			// so an unparsed title yields a fact with dispatchKey null that the
			// bridge must resolve by re-reading the run (whose title is rendered by
			// completion time) before it may cross the ledger boundary.
			if (run.event !== "workflow_dispatch") return null;
			return { kind: "promotion", ...base, dispatchKey: parsePromotionDispatchKey(run.display_title) };
		}
		if (run.path.startsWith(GITHUB_MAIN_DEPLOY_WORKFLOW_PATH)) {
			// The auto-merge fast lane's deploy leg: a completed main deploy is
			// promotion-equivalent evidence. The run deploys exactly its head
			// revision, so head_sha is the identity — matched later against the
			// merged fact's merge commit.
			if (run.event !== "push" && run.event !== "workflow_dispatch") return null;
			if (run.head_branch !== "main") return null;
			if (typeof run.head_sha !== "string" || !SHA.test(run.head_sha)) return null;
			return { kind: "main-deploy", ...base, headSha: run.head_sha };
		}
		return null;
	}
	if (event === "pull_request") {
		const pull = payload.pull_request;
		if (!pull || typeof pull !== "object" || !pull.head || typeof pull.head !== "object") return null;
		const url = githubHtmlUrl(pull.html_url);
		if (!Number.isSafeInteger(pull.number) || pull.number < 1 || !url) return null;
		if (typeof pull.head.ref !== "string" || !pull.head.ref.startsWith(GITHUB_CANDIDATE_BRANCH_PREFIX)) return null;
		if (typeof pull.head.sha !== "string" || !SHA.test(pull.head.sha)) return null;
		if (payload.action === "opened") {
			// A wake accelerator plus corroborating fact only: the runner's own
			// completion callback stays the authoritative candidate path because it
			// alone carries the active run's bearer credential and reports failure.
			return { kind: "candidate", number: pull.number, url, headSha: pull.head.sha, branch: pull.head.ref };
		}
		if (payload.action === "closed") {
			// The fast lane's merge evidence: a candidate PR that closed merged.
			// The merge commit is what the main deploy workflow will report as its
			// head revision, so it is stored as the join key between the two facts.
			if (pull.merged !== true) return null;
			if (typeof pull.merge_commit_sha !== "string" || !SHA.test(pull.merge_commit_sha)) return null;
			return { kind: "merged", number: pull.number, url, headSha: pull.head.sha, branch: pull.head.ref, mergeCommitSha: pull.merge_commit_sha };
		}
		if (payload.action === "stacked") {
			// GitHub's native-stack membership signal: the PR joined, moved
			// within, or left a server-side stack — and, after the node below
			// merged, was retargeted to the stack's base without a rebase. The
			// bounded fact carries the PR identity plus its live base and stack
			// coordinates; the room compares the base to the node's recorded
			// parent to mark a retargeted survivor.
			const stack = payload.stack && typeof payload.stack === "object" ? payload.stack : pull.stack && typeof pull.stack === "object" ? pull.stack : null;
			if (!stack) return null;
			const base = safeBaseBranch(pull.base?.ref);
			if (!base) return null;
			if (!Number.isSafeInteger(stack.position) || stack.position < 1 || !Number.isSafeInteger(stack.size) || stack.size < stack.position) return null;
			return { kind: "stack", number: pull.number, branch: pull.head.ref, headSha: pull.head.sha, base, position: stack.position, size: stack.size };
		}
		return null;
	}
	return null;
}

/** Re-validate a fact that crossed the bridge->ledger service boundary. */
export function normalizeGithubWebhookFact(value) {
	if (!value || typeof value !== "object") return null;
	if (value.kind === "validation" || value.kind === "promotion" || value.kind === "main-deploy") {
		const base = workflowRunBase({ id: value.runId, html_url: value.url, conclusion: value.conclusion, created_at: value.createdAt });
		if (!base) return null;
		if (value.kind === "promotion") {
			// A promotion fact without its durable dispatch key has no ledger
			// identity: the bridge resolves the key before this boundary or drops.
			return typeof value.dispatchKey === "string" && IDENTIFIER.test(value.dispatchKey) ? { kind: "promotion", ...base, dispatchKey: value.dispatchKey } : null;
		}
		return typeof value.headSha === "string" && SHA.test(value.headSha) ? { kind: value.kind, ...base, headSha: value.headSha } : null;
	}
	if (value.kind === "stack") {
		const base = safeBaseBranch(value.base);
		if (!Number.isSafeInteger(value.number) || value.number < 1 || !base) return null;
		if (typeof value.branch !== "string" || !value.branch.startsWith(GITHUB_CANDIDATE_BRANCH_PREFIX)) return null;
		if (typeof value.headSha !== "string" || !SHA.test(value.headSha)) return null;
		if (!Number.isSafeInteger(value.position) || value.position < 1 || !Number.isSafeInteger(value.size) || value.size < value.position) return null;
		return { kind: "stack", number: value.number, branch: value.branch, headSha: value.headSha, base, position: value.position, size: value.size };
	}
	if (value.kind === "candidate" || value.kind === "merged") {
		const url = githubHtmlUrl(value.url);
		if (!Number.isSafeInteger(value.number) || value.number < 1 || !url) return null;
		if (typeof value.branch !== "string" || !value.branch.startsWith(GITHUB_CANDIDATE_BRANCH_PREFIX)) return null;
		if (typeof value.headSha !== "string" || !SHA.test(value.headSha)) return null;
		if (value.kind === "merged") {
			return typeof value.mergeCommitSha === "string" && SHA.test(value.mergeCommitSha)
				? { kind: "merged", number: value.number, url, headSha: value.headSha, branch: value.branch, mergeCommitSha: value.mergeCommitSha }
				: null;
		}
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
	if (fact.kind === "merged" || fact.kind === "stack") {
		// The pull request carries both immutable candidate identities: prefer
		// the recorded candidate head revision, fall back to the plan branch.
		const exact = ordered.find((item) => item.artifacts?.candidate?.headSha === fact.headSha || item.plan?.branch === fact.branch)?.id;
		if (exact) return exact;
		// The durable join is the ISSUE NUMBER inside the branch name: every
		// generation of a request shares it, and no restack rotates it away. A
		// merge of ANY generation belongs to the item with that issue - without
		// this, an item that restacked past its own merge regenerates forever
		// (observed live: one request reached generation 12 re-implementing its
		// own shipped change).
		const issue = Number(/^app-harness-os\/(\d+)\/g\d+$/u.exec(fact.branch ?? "")?.[1]);
		if (Number.isInteger(issue) && issue > 0) {
			return ordered.find((item) => item.artifacts?.issue?.number === issue)?.id ?? null;
		}
		return null;
	}
	return null;
}

/**
 * A main deploy run deploys whatever main is, so one completed run is deploy
 * evidence for EVERY live item whose merge commit its head contains. The exact
 * join is head revision === recorded merge commit. Containment is the
 * descendant relation, and main history is linear (squash merges only), so a
 * SUCCESSFUL run created after an item's merged fact was recorded provably
 * deployed a descendant of that item's merge commit — that temporal join keeps
 * back-to-back merges (whose queued deploy runs GitHub cancels) on the fast
 * lane instead of forcing the heavyweight promotion fallback.
 */
export function matchGithubMainDeployToWorkItems(fact, items, merges = []) {
	const live = new Set(items.map((item) => item.id));
	const matched = [];
	for (const entry of merges) {
		if (!live.has(entry.workItemId)) continue;
		if (entry.mergeCommitSha === fact.headSha) {
			matched.push(entry.workItemId);
		} else if (fact.conclusion === "success" && Number.isFinite(entry.mergedAt) && Date.parse(fact.createdAt) > entry.mergedAt) {
			matched.push(entry.workItemId);
		}
	}
	return matched;
}

/**
 * Monotonic merge into the per-item external-fact record. Returns the merged
 * record, or null when the delivery adds nothing: a duplicate, an older run,
 * or a null conclusion after a recorded one — evidence is never downgraded.
 */
export function mergeGithubFact(existing, fact, now) {
	const facts = existing && typeof existing === "object" ? existing : {};
	if (fact.kind === "validation" || fact.kind === "promotion" || fact.kind === "main-deploy") {
		const key = fact.kind === "main-deploy" ? "mainDeploy" : fact.kind;
		const current = facts[key];
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
		if (fact.kind === "promotion") merged.dispatchKey = fact.dispatchKey;
		else merged.headSha = fact.headSha;
		return { ...facts, [key]: merged };
	}
	if (fact.kind === "candidate") {
		if (facts.candidate && facts.candidate.headSha === fact.headSha) return null;
		return { ...facts, candidate: { number: fact.number, url: fact.url, headSha: fact.headSha, branch: fact.branch, at: now } };
	}
	if (fact.kind === "merged") {
		// Idempotent per merge commit: a candidate merges exactly once.
		if (facts.merged && facts.merged.mergeCommitSha === fact.mergeCommitSha) return null;
		return { ...facts, merged: { number: fact.number, url: fact.url, headSha: fact.headSha, branch: fact.branch, mergeCommitSha: fact.mergeCommitSha, at: now } };
	}
	if (fact.kind === "stack") {
		// Last coordinates win, idempotent per exact membership state: only a
		// changed base, position, size, or head is new evidence.
		const current = facts.stack;
		if (current && current.headSha === fact.headSha && current.base === fact.base && current.position === fact.position && current.size === fact.size) return null;
		return { ...facts, stack: { number: fact.number, branch: fact.branch, headSha: fact.headSha, base: fact.base, position: fact.position, size: fact.size, at: now } };
	}
	return null;
}

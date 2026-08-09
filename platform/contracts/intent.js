const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;

export const INTENT_STATES = ["open", "dispatched", "live", "parked", "withdrawn"];
export const TERMINAL_INTENT_STATES = new Set(["live", "parked", "withdrawn"]);

/** Per-user cap on simultaneously open (non-terminal) intents. */
export const OPEN_INTENT_LIMIT = 5;

function identifier(value, label) {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a bounded identifier.`);
	return value;
}

function timestamp(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer timestamp.`);
	return value;
}

function refs(value) {
	if (!value || typeof value !== "object") throw new Error("Intent refs must be an object of ledger pointers.");
	const { utteranceSeqs, annotationSeqs } = value;
	for (const [seqs, label] of [[utteranceSeqs, "utteranceSeqs"], [annotationSeqs, "annotationSeqs"]]) {
		if (!Array.isArray(seqs) || seqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) throw new Error(`Intent ${label} must be positive ledger sequences.`);
	}
	return { utteranceSeqs: [...utteranceSeqs], annotationSeqs: [...annotationSeqs] };
}

/**
 * An intent is a VERSIONED POINTER into the append-only ledger — the evidence
 * (utterances, verbatim annotations) lives in the ledger; the intent names it
 * and tracks lifecycle. It is never a frozen ticket.
 */
export function createIntent({ id, openedBy, at, refs: pointers }) {
	return {
		schemaVersion: 1,
		id: identifier(id, "Intent ID"),
		openedBy: identifier(openedBy, "Intent opener"),
		state: "open",
		version: 1,
		refs: refs(pointers),
		openedAt: timestamp(at, "Open timestamp"),
		updatedAt: at,
	};
}

/**
 * Where an amendment lands (v1 scope ruling #20): while the intent is still
 * open it amends in place (version++); once dispatched — or terminal — the
 * amendment becomes a FOLLOW-UP intent. There is no steer file in v1.
 */
export function amendmentDisposition(intent) {
	return intent.state === "open" ? "amend" : "follow-up";
}

/** open -> open, version++. New pointers append; nothing is replaced. */
export function amendIntent(intent, { refs: pointers, at }) {
	timestamp(at, "Amend timestamp");
	if (amendmentDisposition(intent) !== "amend") throw new Error(`Intent ${intent.id} is ${intent.state}; amendments become follow-up intents.`);
	const added = refs(pointers);
	return {
		...intent,
		version: intent.version + 1,
		refs: {
			utteranceSeqs: [...intent.refs.utteranceSeqs, ...added.utteranceSeqs],
			annotationSeqs: [...intent.refs.annotationSeqs, ...added.annotationSeqs],
		},
		updatedAt: at,
	};
}

/** open -> dispatched: the intent's run has been admitted to the build queue. */
export function dispatchIntent(intent, { runId, at }) {
	identifier(runId, "Run ID");
	timestamp(at, "Dispatch timestamp");
	if (intent.state !== "open") throw new Error(`Intent ${intent.id} is ${intent.state}, not open.`);
	return { ...intent, state: "dispatched", version: intent.version + 1, runId, updatedAt: at };
}

/** dispatched -> live|parked, from the run's terminal fact. */
export function recordIntentOutcome(intent, { state, at, detail }) {
	timestamp(at, "Outcome timestamp");
	if (state !== "live" && state !== "parked") throw new Error("An intent outcome is live or parked.");
	if (intent.state !== "dispatched") throw new Error(`Intent ${intent.id} is ${intent.state}, not dispatched.`);
	return { ...intent, state, version: intent.version + 1, updatedAt: at, ...(detail === undefined ? {} : { detail }) };
}

/** open -> withdrawn: the cancel window, or an explicit user withdrawal. */
export function withdrawIntent(intent, { at }) {
	timestamp(at, "Withdraw timestamp");
	if (intent.state !== "open") throw new Error(`Intent ${intent.id} is ${intent.state}; only open intents withdraw.`);
	return { ...intent, state: "withdrawn", version: intent.version + 1, updatedAt: at };
}

/** Open-intent pressure for one user: open + dispatched both count against the cap. */
export function countOpenIntents(intents, userId) {
	identifier(userId, "User");
	return intents.filter((intent) => intent.openedBy === userId && !TERMINAL_INTENT_STATES.has(intent.state)).length;
}

export function underOpenIntentLimit(intents, userId, limit = OPEN_INTENT_LIMIT) {
	return countOpenIntents(intents, userId) < limit;
}

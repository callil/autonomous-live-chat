/**
 * Phase-2 seams. The Room DO drives these ports from its reconciler; phase 1
 * ships honest stubs so the durable spine (ledger, queue, feed, control
 * endpoints) is real end to end while the sandbox dispatch integration and
 * the Doctor land later.
 */

/** What the reconciler hands the builder at dispatch time. */
export type RunnerDispatch = {
	runId: string;
	/** Fresh per-dispatch attempt identity — the only identity whose results are accepted. */
	attemptId: string;
	intentId: string;
	/** Verbatim anchored evidence from the ledger: every annotation payload, per-requester attributed. */
	evidence: { requestText: string; requestedBy: string; annotations: unknown[] };
};

export type RunnerDispatchResult =
	| { accepted: true }
	| { accepted: false; reason: string };

/**
 * TODO(phase 2): implement against the sandbox runner (port the
 * native-git-runner patterns: deterministic sandbox identity, per-attempt
 * process identity, push-based completion callback with runId as bearer).
 */
export interface RunnerPort {
	startRun(dispatch: RunnerDispatch): Promise<RunnerDispatchResult>;
}

/** The full case file the Doctor sees on a deviation. */
export type DoctorCase = {
	kind: "run-ttl-exceeded" | "zombie-result" | "unrecognized-state";
	runId?: string;
	intentId?: string;
	detail: string;
};

export type DoctorVerdict = {
	disposition: "park-for-human";
	/** Deterministic public status note; phase 1 has no model in this path. */
	publicNote: string;
};

/**
 * TODO(phase 2): strong-model Doctor invoked only on deviations, output
 * constrained to typed commands + park-for-human + a public status note.
 */
export interface DoctorPort {
	consult(caseFile: DoctorCase): Promise<DoctorVerdict>;
}

/** Phase 1: the builder is not wired up; dispatches are refused honestly. */
export class StubRunnerPort implements RunnerPort {
	async startRun(): Promise<RunnerDispatchResult> {
		return { accepted: false, reason: "runner-port-not-configured" };
	}
}

/** Phase 1: every deviation parks for a human with a deterministic note. */
export class StubDoctorPort implements DoctorPort {
	async consult(caseFile: DoctorCase): Promise<DoctorVerdict> {
		return { disposition: "park-for-human", publicNote: `Parked for human review (${caseFile.kind}): ${caseFile.detail}` };
	}
}

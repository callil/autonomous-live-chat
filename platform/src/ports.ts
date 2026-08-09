/**
 * The Room DO drives these ports from its reconciler. Phase 2 ships the real
 * sandbox RunnerPort (a service binding to the platform runner Worker); the
 * Doctor remains an honest deterministic stub until phase 3.
 */

/** What the reconciler hands the builder at dispatch time. */
export type RunnerDispatch = {
	runId: string;
	/** Fresh per-dispatch attempt identity — the only identity whose results are accepted. */
	attemptId: string;
	intentId: string;
	/** The plain branch the runner must create from latest main: room/<intentSeq>/<attempt>. */
	branch: string;
	/** Verbatim anchored evidence from the ledger: every annotation payload, per-requester attributed. */
	evidence: { requestText: string; requestedBy: string; annotations: unknown[] };
	/** Public feed link for the commit's Requested-by trailer. */
	feedUrl: string;
	/** Short-lived GitHub App installation token minted by the platform for this dispatch. */
	gitToken: string;
};

export type RunnerDispatchResult =
	| { accepted: true }
	| { accepted: false; reason: string };

/**
 * The sandbox runner seam. The real implementation is an RPC service binding
 * to the platform runner Worker (platform/runner), which boots one sandbox
 * container per run and reports back by push to /api/runner/complete with
 * the runId as bearer plus the attempt ID as zombie guard.
 */
export interface RunnerPort {
	startRun(dispatch: RunnerDispatch): Promise<RunnerDispatchResult>;
}

/** The shape of the runner Worker's RPC entrypoint, seen through the service binding. */
export type RunnerBinding = {
	startRun(dispatch: RunnerDispatch): Promise<{ accepted?: unknown; reason?: unknown }>;
};

/** The real RunnerPort: dispatch over the private service binding, refusals stay honest. */
export class BindingRunnerPort implements RunnerPort {
	private readonly binding: RunnerBinding;

	constructor(binding: RunnerBinding) {
		this.binding = binding;
	}

	async startRun(dispatch: RunnerDispatch): Promise<RunnerDispatchResult> {
		try {
			const result = await this.binding.startRun(dispatch);
			if (result?.accepted === true) return { accepted: true };
			return { accepted: false, reason: typeof result?.reason === "string" ? result.reason.slice(0, 200) : "runner-refused" };
		} catch (error) {
			return { accepted: false, reason: `runner-unreachable: ${(error instanceof Error ? error.message : "rpc-failed").slice(0, 160)}` };
		}
	}
}

/** The full case file the Doctor sees on a deviation. */
export type DoctorCase = {
	kind:
		| "run-ttl-exceeded"
		| "verify-ttl-exceeded"
		| "deploy-ttl-exceeded"
		| "ci-red"
		| "merge-refused"
		| "liveness-failed-migration"
		| "zombie-result"
		| "unrecognized-state";
	runId?: string;
	intentId?: string;
	detail: string;
};

export type DoctorVerdict = {
	disposition: "park-for-human";
	/** Deterministic public status note; phase 2 has no model in this path. */
	publicNote: string;
};

/**
 * TODO(phase 3): strong-model Doctor invoked only on deviations, output
 * constrained to typed commands + park-for-human + a public status note.
 */
export interface DoctorPort {
	consult(caseFile: DoctorCase): Promise<DoctorVerdict>;
}

/** Fallback when the runner binding is not configured; dispatches are refused honestly. */
export class StubRunnerPort implements RunnerPort {
	async startRun(): Promise<RunnerDispatchResult> {
		return { accepted: false, reason: "runner-port-not-configured" };
	}
}

/** Phase 2: every deviation parks for a human with a deterministic note. */
export class StubDoctorPort implements DoctorPort {
	async consult(caseFile: DoctorCase): Promise<DoctorVerdict> {
		return { disposition: "park-for-human", publicNote: `Parked for human review (${caseFile.kind}): ${caseFile.detail}` };
	}
}

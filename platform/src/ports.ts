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
	/**
	 * The deterministic size class for this run. It tunes only the agent's own
	 * budgets (reasoning effort, tool ceiling, whether the repository tree
	 * rides the prompt) — never the local gate, never CI, never the firewall.
	 */
	tier: "small" | "normal";
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
	/** Release the run's container. Best-effort: failure costs nothing but the SDK's idle sleep. */
	finishRun(runId: string): Promise<void>;
}

/** The shape of the runner Worker's RPC entrypoint, seen through the service binding. */
export type RunnerBinding = {
	startRun(dispatch: RunnerDispatch): Promise<{ accepted?: unknown; reason?: unknown }>;
	finishRun(runId: string): Promise<unknown>;
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

	async finishRun(runId: string): Promise<void> {
		try {
			await this.binding.finishRun(runId);
		} catch {
			// Best-effort release; the SDK's idle sleep remains the backstop.
		}
	}
}

export type DoctorCaseKind =
	| "run-ttl-exceeded"
	| "verify-ttl-exceeded"
	| "deploy-ttl-exceeded"
	| "ci-red"
	| "merge-refused"
	| "run-failed"
	| "dispatch-refused"
	| "liveness-failed-migration"
	| "zombie-result"
	| "unrecognized-state";

/**
 * The full case file the Doctor sees on a park event: the mechanical
 * classification, the verbatim request, and the recent ledger facts. The
 * Doctor never sees anything the ledger does not record.
 */
export type DoctorCase = {
	kind: DoctorCaseKind;
	runId?: string;
	intentId?: string;
	detail: string;
	requestText?: string;
	requestedBy?: string;
	/** Whether the retry-once lever is mechanically available for this case. */
	retryAvailable?: boolean;
	/** Bounded recent ledger facts, oldest first. */
	recentEvents?: string[];
};

/**
 * The Doctor's output is CONSTRAINED to two dispositions plus a public note.
 * retry-once re-runs the intent exactly once from latest main; anything else
 * stays parked for a human. No patch DSL, no free-form commands (task #17 is
 * deferred; task #20 binds the output surface).
 */
export type DoctorVerdict = {
	disposition: "stay-parked" | "retry-once";
	/** The public status note, shown verbatim in the room feed. */
	publicNote: string;
};

/**
 * The case kinds where a fresh attempt can honestly change the outcome. A
 * deploy-phase park (merge already landed) or a migration-crossed liveness
 * failure can never be retried by re-building — those park for a human no
 * matter what the model says.
 */
export const RETRYABLE_DOCTOR_KINDS: ReadonlySet<DoctorCaseKind> = new Set([
	"run-ttl-exceeded",
	"verify-ttl-exceeded",
	"ci-red",
	"merge-refused",
	"run-failed",
]);

/**
 * The Doctor seam (phase 3): a strong model invoked ONLY on park events, fed
 * the full case file, output constrained to DoctorVerdict. The deterministic
 * stub remains the fail-open floor when the model or its credential is
 * unavailable.
 */
export interface DoctorPort {
	consult(caseFile: DoctorCase): Promise<DoctorVerdict>;
}

/** Fallback when the runner binding is not configured; dispatches are refused honestly. */
export class StubRunnerPort implements RunnerPort {
	async startRun(): Promise<RunnerDispatchResult> {
		return { accepted: false, reason: "runner-port-not-configured" };
	}

	async finishRun(): Promise<void> {}
}

/** The deterministic floor: every deviation parks for a human with an honest note. */
export class StubDoctorPort implements DoctorPort {
	async consult(caseFile: DoctorCase): Promise<DoctorVerdict> {
		return { disposition: "stay-parked", publicNote: `Parked for human review (${caseFile.kind}): ${caseFile.detail}` };
	}
}

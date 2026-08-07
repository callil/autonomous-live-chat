import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AppHarnessLedger, GitHubRepositoryBinding, NativeGitRunnerBinding, StagedOperatorAction } from "./contracts";
import { executeCommand } from "./execute";
import { callModel, MODEL_CALL_TIMEOUT_MS, ModelError, probeModel, withRetry, type ModelMessage, type ToolCall } from "./model";
import { commandFor, OBSERVATION_TOOLS, SYSTEM_PROMPT, TOOLS } from "./operator-tools.js";

type Env = {
	OPERATOR_TURN: DurableObjectNamespace<OperatorTurn>;
	LEDGER: AppHarnessLedger;
	RUNNER: NativeGitRunnerBinding;
	GITHUB: GitHubRepositoryBinding;
	AI?: { run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
	REPOSITORY: string;
	MODEL_PROVIDER?: string;
	MODEL_ID: string;
	MODEL_BASE_URL: string;
	MODEL_API_KEY?: string;
	MAX_TOOL_CALLS_PER_TURN: string;
	MAX_TOKENS_PER_TURN: string;
	OPERATOR_PAUSED?: string;
};

type OperatorWake = { workItemId: string };

type CallRecord = { name: string; ok: boolean; error?: string };

type TurnState = {
	workItemId: string;
	/** Advancing expectedVersion for staging, refreshed from each receipt. */
	version: number;
	/** Ledger phase at snapshot time; guards the promoting-phase mechanics. */
	phase: string;
	activeRunId: string;
	/** The runner's own process identifier, absorbed from the implement receipt. */
	runnerRunId?: string;
	planBranch: string;
	issueNumber: number;
	candidatePr: number;
	candidateHeadSha: string;
	/** The room-stack branch order beneath this item, from the ledger snapshot; the loop supplies it to the runner, never the model. */
	stackExpectedOrder: string[];
	/** Snapshot facts, injected into evidence-bearing commands. */
	snapshotFacts?: Record<string, Record<string, unknown> | undefined>;
	messages: ModelMessage[];
	toolCalls: number;
	tokens: number;
	startedAt: number;
	status: "running" | "done";
	/** Persisted before execution so a crash-resumed replay stages the identical command. */
	pending?: { callId: string; name: string; args: Record<string, unknown>; minted: string };
	calls: CallRecord[];
	outcome?: string;
};

type Snapshot = {
	version?: number;
	phase?: string;
	activeImplementation?: { runId?: string } | null;
	plan?: { branch?: string } | null;
	artifacts?: { issue?: { number?: number } };
	/** The applied promote action's durable dispatch key, exposed while promoting. */
	promotionDispatch?: { dispatchKey?: string; dispatchedAt?: number };
	/** The item's merge-train coordinates; expectedOrder is loop-owned runner input. */
	stack?: { position?: number; size?: number; expectedOrder?: unknown };
	facts?: Record<string, Record<string, unknown> | undefined>;
};

// Adaptive turn budgeting: the outer envelope is generous because nothing
// re-delivers underneath a live turn any more. Each model call and tool call
// carries its own timeout, and before each model call the loop checks whether
// a bounded call still fits inside the envelope; otherwise the turn ends
// cleanly and the next event (or the DO's own alarm) re-drives it.
const TURN_ENVELOPE_MS = 10 * 60_000;
const OBSERVATION_TIMEOUT_MS = 30_000;
const STAGE_TIMEOUT_MS = 120_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;
// A turn that ends WAITING re-pokes itself: DO-local alarm, no ledger involved.
const WAITING_REPOKE_MS = 60_000;
// Sandbox capacity backpressure: when startRun reports the pool is full, the
// LOOP ends the turn WAITING with this longer re-poke instead of handing the
// error to the model, which would hot-retry it. With admission control at
// three slots against eight sandboxes this is the rare backstop, not the norm.
const CAPACITY_REPOKE_MS = 90_000;
const CAPACITY_WAIT_OUTCOME = "WAITING:sandbox-capacity";
// Crash backstop: if the isolate dies mid-turn, the alarm resumes the
// persisted transcript from its pending record.
const TURN_ALARM_BACKSTOP_MS = 60_000;
const TOOL_RESULT_MAX_CHARS = 4_000;
const ACTION_RESULT_MAX_CHARS = 600;
const RECENT_TURNS_KEPT = 20;

/** Demo-facing wake transport: one fire-and-forget poke, no payload beyond the item. */
export class OperatorGateway extends WorkerEntrypoint<Env> {
	async submitWake(input: OperatorWake): Promise<{ accepted: true } | { accepted: false; message: string }> {
		if (this.env.OPERATOR_PAUSED === "true") return { accepted: false, message: "The operator worker is paused." };
		if (!input || typeof input.workItemId !== "string" || !/^[0-9a-f-]{36}$/iu.test(input.workItemId)) {
			return { accepted: false, message: "The wake is outside the operator contract." };
		}
		return this.env.OPERATOR_TURN.getByName(input.workItemId).acceptWake(input);
	}

	/**
	 * One minimal model call, spent by the ledger sweep while a credit outage
	 * fact stands: the first success is the recovery signal that clears the
	 * fact and resumes pokes.
	 */
	async probeModel(): Promise<{ ok: boolean; status?: number }> {
		return probeModel(this.env);
	}
}

/**
 * One Durable Object per work item: serialized turns, a persisted transcript,
 * and alarm-driven crash resume. The ledger stays the sole durable authority
 * and emits pokes; this object owns its own lifecycle — it reads a fresh
 * ledger snapshot at the start of every turn, runs one bounded model loop,
 * and re-drives itself by its own alarm when it chooses to wait.
 */
export class OperatorTurn extends DurableObject<Env> {
	async acceptWake(wake: OperatorWake): Promise<{ accepted: true } | { accepted: false; message: string }> {
		// A poke carries no state: it only marks that something changed. If a
		// turn is running it finishes first and the mark starts the next one.
		await this.ctx.storage.put("poked", wake.workItemId);
		const turn = await this.ctx.storage.get<TurnState>("turn");
		if (!turn || turn.status !== "running") await this.ctx.storage.setAlarm(Date.now());
		return { accepted: true };
	}

	async alarm(): Promise<void> {
		const turn = await this.ctx.storage.get<TurnState>("turn");
		if (turn?.status === "running") {
			// A running turn under the alarm means the isolate died mid-drive:
			// resume the persisted transcript, unless the envelope is spent.
			if (Date.now() - turn.startedAt > TURN_ENVELOPE_MS) {
				await this.finish(turn, "PARKED:turn-envelope");
				return;
			}
			await this.ctx.storage.setAlarm(Date.now() + TURN_ALARM_BACKSTOP_MS);
			await this.drive(turn);
			return;
		}
		const poked = await this.ctx.storage.get<string>("poked");
		if (poked) await this.startTurn(poked);
	}

	async status(): Promise<unknown> {
		const [turn, recent, spend] = await Promise.all([
			this.ctx.storage.get<TurnState>("turn"),
			this.ctx.storage.get<Array<Record<string, unknown>>>("recent-turns"),
			this.ctx.storage.get<{ turns: number; toolCalls: number; tokens: number }>(`spend:${new Date().toISOString().slice(0, 10)}`),
		]);
		return {
			workItemId: turn?.workItemId ?? null,
			turn: turn
				? { status: turn.status, toolCalls: turn.toolCalls, tokens: turn.tokens, startedAt: turn.startedAt, outcome: turn.outcome ?? null, calls: turn.calls, state: turn.messages.find((entry) => entry.role === "user")?.content ?? null }
				: null,
			recentTurns: recent ?? [],
			spendToday: spend ?? { turns: 0, toolCalls: 0, tokens: 0 },
		};
	}

	private async startTurn(workItemId: string): Promise<void> {
		await this.ctx.storage.delete("poked");
		let ledgerSnapshot: { state: string; version: number; terminal: boolean } | null;
		try {
			ledgerSnapshot = await withTimeout(this.env.LEDGER.snapshotWorkItem({ workItemId }), SNAPSHOT_TIMEOUT_MS, "snapshotWorkItem");
		} catch (error) {
			// An unreachable ledger is not a lost item: the next event or the
			// ledger's periodic sweep pokes again.
			console.error("The operator could not read the ledger snapshot.", { workItemId, error });
			return;
		}
		if (!ledgerSnapshot || ledgerSnapshot.terminal) return;
		const snapshot = parseSnapshot(ledgerSnapshot.state);
		const turn: TurnState = {
			workItemId,
			version: snapshot.version ?? ledgerSnapshot.version,
			phase: typeof snapshot.phase === "string" ? snapshot.phase : "",
			activeRunId: snapshot.activeImplementation?.runId ?? "",
			planBranch: snapshot.plan?.branch ?? "",
			issueNumber: Number.isSafeInteger(snapshot.artifacts?.issue?.number) ? snapshot.artifacts!.issue!.number! : 0,
			candidatePr: Number.isSafeInteger((snapshot.artifacts as { candidate?: { pullRequestNumber?: unknown } } | undefined)?.candidate?.pullRequestNumber) ? (snapshot.artifacts as { candidate: { pullRequestNumber: number } }).candidate.pullRequestNumber : 0,
			candidateHeadSha: typeof (snapshot.artifacts as { candidate?: { headSha?: unknown } } | undefined)?.candidate?.headSha === "string" ? (snapshot.artifacts as { candidate: { headSha: string } }).candidate.headSha : "",
			stackExpectedOrder: safeExpectedOrder(snapshot.stack?.expectedOrder),
			snapshotFacts: snapshot.facts ?? undefined,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `State: ${ledgerSnapshot.state}` },
			],
			toolCalls: 0,
			tokens: 0,
			startedAt: Date.now(),
			status: "running",
			calls: [],
		};
		await this.observePromotionIfBlind(turn, snapshot);
		// Durable before any model call, so a restart resumes instead of
		// restarting; the alarm is both the driver and the crash backstop.
		await this.ctx.storage.put("turn", turn);
		await this.ctx.storage.setAlarm(Date.now() + TURN_ALARM_BACKSTOP_MS);
		await this.drive(turn);
	}

	/**
	 * Promoting-phase self-rescue, loop-owned by doctrine: when the snapshot
	 * shows phase promoting with no pushed promotion fact (the webhook fact can
	 * be lost to GitHub's unreliable display_title rendering), the LOOP observes
	 * the promotion run through the GITHUB binding — once per turn, bounded —
	 * and injects the concluded run into the snapshot facts. The model's next
	 * action is then simply stageState with loop-injected evidence; commandFor
	 * already overrides artifacts from ctx.facts.
	 */
	private async observePromotionIfBlind(turn: TurnState, snapshot: Snapshot): Promise<void> {
		const dispatchKey = snapshot.promotionDispatch?.dispatchKey;
		if (turn.phase !== "promoting" || turn.snapshotFacts?.promotion || typeof dispatchKey !== "string" || !dispatchKey) return;
		let run: { runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null;
		try {
			run = await withTimeout(this.env.GITHUB.findPromotionRun({ dispatchKey }), OBSERVATION_TIMEOUT_MS, "findPromotionRun");
		} catch (error) {
			// An unobservable run is not a lost item: the next wake retries.
			console.error("The loop could not observe the promotion run.", { workItemId: turn.workItemId, error });
			return;
		}
		if (!run || run.conclusion === null) return;
		turn.snapshotFacts = { ...(turn.snapshotFacts ?? {}), promotion: { runId: run.runId, url: run.url, conclusion: run.conclusion, createdAt: run.createdAt, dispatchKey, at: Date.now() } };
		turn.messages.push({
			role: "user",
			content: `Loop observation: the promotion run for this item concluded ${run.conclusion} (${run.url}). This evidence is now State.facts.promotion. On success, stageState deployed; on failure, stageState retryable and restack.`,
		});
	}

	private async drive(turn: TurnState): Promise<void> {
		while (turn.status === "running") {
			// Resume a tool call interrupted mid-execution: the persisted pending
			// record replays the identical command, and the ledger's effect keys
			// return the existing action rather than double-executing.
			if (turn.pending) {
				await this.performPending(turn);
				continue;
			}
			if (turn.toolCalls >= Number(this.env.MAX_TOOL_CALLS_PER_TURN)) return this.finish(turn, "PARKED:tool-budget");
			if (turn.tokens >= Number(this.env.MAX_TOKENS_PER_TURN)) return this.finish(turn, "PARKED:token-budget");
			// Adaptive budgeting: only start a bounded model call that still fits
			// within the turn envelope; otherwise end the turn cleanly.
			if (Date.now() - turn.startedAt + MODEL_CALL_TIMEOUT_MS > TURN_ENVELOPE_MS) return this.finish(turn, "PARKED:turn-envelope");

			let reply;
			try {
				reply = await withRetry(() => callModel(this.env, turn.messages, TOOLS, Number(this.env.MAX_TOKENS_PER_TURN) - turn.tokens), {
					attempts: 3,
					baseMs: 500,
					// An exhausted balance is not transient overload: no retry can
					// succeed until the balance is restored, so it is never retried.
					retryOn: (error) => (error instanceof ModelError && (error.status === 429 || error.status >= 500) && !error.creditsExhausted) || error instanceof TypeError,
				});
			} catch (error) {
				if (error instanceof ModelError && error.creditsExhausted) {
					// Exhausted credits are a system-wide outage, not a work-item
					// failure: report the health note to the ledger — which pauses
					// sweep pokes and probes for recovery — then park distinctly.
					await this.env.LEDGER.ingestExternalFact({ source: "operator", workItemId: turn.workItemId, note: "model-credits-exhausted" })
						.catch((noteError) => console.error("Failed to report exhausted model credits to the ledger.", { workItemId: turn.workItemId, noteError }));
					return this.finish(turn, "PARKED:model-credits-exhausted");
				}
				// A dead provider is not a work-item failure: park this turn and let
				// the next event or the ledger sweep re-drive it later.
				return this.finish(turn, `PARKED:model-unavailable:${String(error instanceof Error ? error.message : error).slice(0, 80)}`);
			}
			turn.tokens += reply.usage?.total_tokens ?? 0;
			turn.messages.push(reply.message);

			const calls = reply.message.tool_calls ?? [];
			if (calls.length === 0) return this.finish(turn, outcomeFromReply(reply.message.content, turn));
			// parallel_tool_calls is off; if a provider still returns extras, every
			// call id must be answered for the transcript to stay valid.
			for (const extra of calls.slice(1)) {
				turn.messages.push({ role: "tool", tool_call_id: extra.id, content: JSON.stringify({ error: "One command per step. Repeat this call on its own." }) });
			}
			const call = calls[0];
			turn.toolCalls += 1;
			turn.pending = { callId: call.id, name: call.function.name, args: parseArguments(call), minted: crypto.randomUUID() };
			await this.ctx.storage.put("turn", turn);
		}
	}

	private async performPending(turn: TurnState): Promise<void> {
		const pending = turn.pending!;
		// Every tool call carries its own budget: observations are quick reads,
		// stage/execute may boot a sandbox run. A timeout is data the model sees.
		const budget = OBSERVATION_TOOLS.has(pending.name) ? OBSERVATION_TIMEOUT_MS : STAGE_TIMEOUT_MS;
		let result: Record<string, unknown>;
		try {
			result = await withTimeout(this.invokeTool(turn, pending), budget, pending.name);
		} catch (error) {
			result = { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
		}
		turn.messages.push({ role: "tool", tool_call_id: pending.callId, content: JSON.stringify(result).slice(0, TOOL_RESULT_MAX_CHARS) });
		const failure = (result as { error?: unknown }).error;
		turn.calls.push({ name: pending.name, ok: failure === undefined, ...(typeof failure === "string" ? { error: failure.slice(0, 200) } : {}) });
		turn.pending = undefined;
		await this.ctx.storage.put("turn", turn);
		// Sandbox capacity exhaustion is backpressure, not model feedback: a
		// model shown the error hot-retries it. The loop ends the turn WAITING
		// under its own longer re-poke and lets the pool drain passively.
		if (pending.name === "stageImplementation" && typeof failure === "string" && failure.includes("sandbox-capacity-exhausted")) {
			return this.finish(turn, CAPACITY_WAIT_OUTCOME);
		}
	}

	private async invokeTool(turn: TurnState, pending: NonNullable<TurnState["pending"]>): Promise<Record<string, unknown>> {
		const { name, args, minted } = pending;
		try {
			if (OBSERVATION_TOOLS.has(name)) {
				switch (name) {
					case "getMainSha": return { ...await this.env.GITHUB.getMainSha() };
					case "getCandidate": return { candidate: await this.env.GITHUB.getCandidate(args as { branch: string; pullRequestBase: string }) };
					case "observeCandidateValidation": return { validation: await this.env.GITHUB.observeCandidateValidation(args as { pullRequest: number; headSha: string }) };
					case "observeCandidatePullRequest": {
						// The pull request number is the ledger's recorded candidate
						// identity, loop-injected from the snapshot artifact — never a
						// model argument, so a typo cannot observe someone else's PR.
						if (!turn.candidatePr) return { error: "No candidate pull request is recorded for this work item yet." };
						return { pullRequest: await this.env.GITHUB.observeCandidatePullRequest({ number: turn.candidatePr }) };
					}
					case "findPromotionRun": return { run: await this.env.GITHUB.findPromotionRun({ dispatchKey: String(args.dispatchKey), ...(typeof args.createdAfter === "string" ? { createdAfter: args.createdAfter } : {}) }) };
					case "inspectPromotionRun": return { ...await this.env.GITHUB.observeWorkflowRun(args as { runId: number }) };
					case "inspectImplementation": {
						// The process id is a loop-owned fact from the implement receipt,
						// never a model argument: the ledger and runner identifiers are
						// distinct and the runner refuses a mismatched inspection.
						if (!turn.runnerRunId) return { error: "The runner process id is not known in this turn. The completion callback will wake this item; reply WAITING if there is nothing else to do." };
						return { run: await this.env.RUNNER.inspectRun({ jobId: turn.workItemId, generation: Number(args.generation), runId: turn.runnerRunId }) };
					}
				}
			}
			// Reject-with-teaching, loop-side: an item already promoting must never
			// re-dispatch. The data error names the productive next step instead of
			// letting the ledger's phase guard reject the same mistake every turn.
			if (name === "stagePromotion" && turn.phase === "promoting") {
				return { error: "This item is already promoting — do not dispatch promotion again. When State.facts.promotion carries a success conclusion, stageState deployed with that evidence; on a failure conclusion stageState retryable and restack; otherwise reply WAITING." };
			}
			const command = commandFor(name, args, {
				minted,
				activeRunId: turn.activeRunId,
				planBranch: turn.planBranch,
				issueNumber: turn.issueNumber,
				candidatePr: turn.candidatePr,
				candidateHeadSha: turn.candidateHeadSha,
				// The merge-train order beneath this item, from the snapshot:
				// mechanical runner input the model must never retype.
				expectedOrder: turn.stackExpectedOrder,
				facts: turn.snapshotFacts,
			});
			return this.stageAndExecute(turn, command);
		} catch (error) {
			// Tool-level failure is data, not a crash: the model sees it and corrects.
			return { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
		}
	}

	/** Stage, begin, execute, and complete one command through the ledger's protocol. */
	private async stageAndExecute(turn: TurnState, command: Parameters<AppHarnessLedger["stageOperatorAction"]>[0]["command"]): Promise<Record<string, unknown>> {
		// 1. Durable log first. Idempotency keys and the single-active lock are
		//    the ledger's, unchanged; a duplicate returns the existing action.
		const staged = await this.env.LEDGER.stageOperatorAction({ workItemId: turn.workItemId, expectedVersion: turn.version, command });
		if (staged.status === "applied") {
			// A crash-resumed replay lands here: the command already executed.
			// The receipt must still be absorbed, or every later command in
			// this turn stages against the pre-action revision and is refused.
			await this.absorbAppliedAction(turn, command, staged);
			return summarizeAction(staged);
		}
		if (staged.status === "rejected") return summarizeAction(staged);
		// 2. Claim execution under the ledger's bounded per-action lease.
		const begun = await this.env.LEDGER.beginOperatorAction({ workItemId: turn.workItemId, actionId: staged.id });
		if (begun.disposition !== "execute" || !begun.executionToken) {
			if (begun.action.status === "applied") await this.absorbAppliedAction(turn, command, begun.action);
			return summarizeAction(begun.action);
		}
		// 3. Execute against the private capabilities, then record the truth.
		try {
			const result = await executeCommand(this.env, begun.workItem, begun.action.command);
			const done = await this.env.LEDGER.completeOperatorAction({ workItemId: turn.workItemId, actionId: staged.id, idempotencyKey: begun.action.idempotencyKey, executionToken: begun.executionToken, result });
			this.absorbReceipt(turn, command, result);
			await this.ctx.storage.put("turn", turn);
			return summarizeAction(done);
		} catch (error) {
			// The rejection carries the reason into the ledger and back to the
			// model in the same turn.
			const message = error instanceof Error ? error.message : String(error);
			const rejected = await this.env.LEDGER.rejectOperatorAction({ workItemId: turn.workItemId, actionId: staged.id, executionToken: begun.executionToken, error: message });
			return summarizeAction(rejected);
		}
	}

	/** A replayed or reconciled applied action carries its receipt as a JSON string. */
	private async absorbAppliedAction(turn: TurnState, command: { kind: string; runId?: string }, action: { result?: unknown }): Promise<void> {
		if (action.result === undefined || action.result === null) return;
		try {
			this.absorbReceipt(turn, command, typeof action.result === "string" ? JSON.parse(action.result) : action.result);
			await this.ctx.storage.put("turn", turn);
		} catch { /* an unparseable receipt leaves the turn state as it was */ }
	}

	/** Keep the loop-owned staging facts current as receipts arrive. */
	private absorbReceipt(turn: TurnState, command: { kind: string; runId?: string }, result: unknown): void {
		const receipt = result as { version?: unknown; phase?: unknown; ledger?: { version?: unknown; phase?: unknown } };
		const version = Number.isSafeInteger(receipt?.version) ? receipt.version as number : Number.isSafeInteger(receipt?.ledger?.version) ? receipt.ledger!.version as number : undefined;
		if (version !== undefined) turn.version = version;
		const phase = typeof receipt?.phase === "string" ? receipt.phase : typeof receipt?.ledger?.phase === "string" ? receipt.ledger.phase : undefined;
		if (phase !== undefined) turn.phase = phase;
		if (command.kind === "implement" && typeof command.runId === "string") turn.activeRunId = command.runId;
		const runner = (result as { runner?: { runId?: unknown } })?.runner;
		if (runner && typeof runner.runId === "string") turn.runnerRunId = runner.runId;
		if (command.kind === "record-candidate") {
			const candidate = command as { pullRequestNumber?: unknown; headSha?: unknown };
			if (Number.isSafeInteger(candidate.pullRequestNumber)) turn.candidatePr = candidate.pullRequestNumber as number;
			if (typeof candidate.headSha === "string") turn.candidateHeadSha = candidate.headSha;
		}
	}

	private async finish(turn: TurnState, outcome: string): Promise<void> {
		const endedAt = Date.now();
		turn.status = "done";
		turn.outcome = outcome;
		const day = new Date().toISOString().slice(0, 10);
		const spend = (await this.ctx.storage.get<{ turns: number; toolCalls: number; tokens: number }>(`spend:${day}`)) ?? { turns: 0, toolCalls: 0, tokens: 0 };
		const recent = (await this.ctx.storage.get<Array<Record<string, unknown>>>("recent-turns")) ?? [];
		recent.push({ outcome, toolCalls: turn.toolCalls, tokens: turn.tokens, endedAt, calls: turn.calls });
		await Promise.all([
			this.ctx.storage.put("turn", turn),
			this.ctx.storage.put(`spend:${day}`, { turns: spend.turns + 1, toolCalls: spend.toolCalls + turn.toolCalls, tokens: spend.tokens + turn.tokens }),
			this.ctx.storage.put("recent-turns", recent.slice(-RECENT_TURNS_KEPT)),
		]);
		if (await this.ctx.storage.get("poked")) {
			// Events arrived while this turn ran; start the next one immediately.
			await this.ctx.storage.setAlarm(Date.now());
			return;
		}
		if (outcome === "WAITING" || outcome === CAPACITY_WAIT_OUTCOME) {
			// The turn wants a time-based re-poke: the DO sets its own alarm and
			// re-drives itself with a fresh snapshot. No ledger involvement. A
			// capacity wait re-pokes later than an ordinary wait.
			await this.ctx.storage.put("poked", turn.workItemId);
			await this.ctx.storage.setAlarm(Date.now() + (outcome === CAPACITY_WAIT_OUTCOME ? CAPACITY_REPOKE_MS : WAITING_REPOKE_MS));
			return;
		}
		await this.ctx.storage.deleteAlarm();
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms budget.`)), ms)),
	]);
}

/** The snapshot's merge-train order beneath this item: canonical branch names only, bounded, or empty. */
function safeExpectedOrder(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 16) return [];
	const order = value.filter((branch): branch is string => typeof branch === "string" && /^app-harness-os\/\d+\/g\d+$/u.test(branch));
	return order.length === value.length ? order : [];
}

function parseSnapshot(state: string): Snapshot {
	try {
		const parsed = JSON.parse(state) as unknown;
		return parsed && typeof parsed === "object" ? parsed as Snapshot : {};
	} catch {
		return {};
	}
}

function parseArguments(call: ToolCall): Record<string, unknown> {
	try {
		const parsed = JSON.parse(call.function.arguments) as unknown;
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function summarizeAction(action: StagedOperatorAction): Record<string, unknown> {
	const state = action.status === "applied" ? "completed" : action.status === "rejected" ? "rejected" : action.status === "staged" ? "queued" : "already-queued";
	const failure = action.status === "rejected" && action.result && typeof action.result === "object" && typeof (action.result as { error?: unknown }).error === "string"
		? String((action.result as { error: string }).error).slice(0, 300)
		: undefined;
	return {
		actionId: action.id,
		kind: action.command.kind,
		state,
		...(failure ? { error: failure } : {}),
		...(action.result !== undefined && !failure ? { result: JSON.stringify(action.result).slice(0, ACTION_RESULT_MAX_CHARS) } : {}),
	};
}

function outcomeFromReply(content: string | null, turn: TurnState): string {
	const text = typeof content === "string" ? content.trim().replace(/\s+/gu, " ").slice(0, 200) : "";
	if (/^(?:PROGRESSED|WAITING|PARKED:[A-Za-z0-9._-]+|COMPLETE)$/u.test(text)) return text;
	if (text) return text;
	return turn.calls.some((call) => call.ok) ? "PROGRESSED" : "PARKED:no-reply";
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
		const url = new URL(request.url);
		if (url.pathname === "/status") return Response.json({ ok: true, service: "app-harness-operator", paused: env.OPERATOR_PAUSED === "true" });
		const match = url.pathname.match(/^\/status\/([0-9a-f-]{36})$/iu);
		if (!match) return new Response("Not found", { status: 404 });
		const workItemId = match[1].toLowerCase();
		return Response.json(await env.OPERATOR_TURN.getByName(workItemId).status());
	},
} satisfies ExportedHandler<Env>;

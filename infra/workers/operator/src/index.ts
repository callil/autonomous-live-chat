import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AppHarnessLedger, GitHubRepositoryBinding, NativeGitRunnerBinding, StagedOperatorAction } from "./contracts";
import { executeCommand } from "./execute";
import { callModel, ModelError, withRetry, type ModelMessage, type ToolCall } from "./model";
import { commandFor, OBSERVATION_TOOLS, PARKING_TOOLS, SYSTEM_PROMPT, TOOLS } from "./operator-tools.js";

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

type OperatorWake = { workItemId: string; version: number; turn: number; wakeKey: string; state: string };

type CallRecord = { name: string; ok: boolean; error?: string };

type TurnState = {
	wakeKey: string;
	workItemId: string;
	/** The wake's revision: the note settles against exactly this version. */
	wakeVersion: number;
	turnNumber: number;
	/** Advancing expectedVersion for staging, refreshed from each receipt. */
	version: number;
	leaseId: string | null;
	activeRunId: string;
	planBranch: string;
	issueNumber: number;
	messages: ModelMessage[];
	toolCalls: number;
	tokens: number;
	startedAt: number;
	status: "running" | "done";
	/** Persisted before execution so a crash-resumed replay stages the identical command. */
	pending?: { callId: string; name: string; args: Record<string, unknown>; minted: string };
	calls: CallRecord[];
	outcome?: string;
	noteDue?: boolean;
	noteAttempts?: number;
};

type TurnOutcome = { outcome: string; toolCalls: number; tokens: number; endedAt: number };
type Snapshot = {
	version?: number;
	leaseId?: string | null;
	activeImplementation?: { runId?: string } | null;
	plan?: { branch?: string } | null;
	artifacts?: { issue?: { number?: number } };
};

const TURN_WALL_CLOCK_MS = 60_000;
const TURN_ALARM_BACKSTOP_MS = TURN_WALL_CLOCK_MS + 10_000;
const NOTE_RETRY_MS = 5_000;
const NOTE_ATTEMPT_BUDGET = 3;
const TOOL_RESULT_MAX_CHARS = 4_000;
const ACTION_RESULT_MAX_CHARS = 600;
const RECENT_TURNS_KEPT = 20;

/** Demo-facing wake transport. One structured wake, one bounded model turn. */
export class OperatorGateway extends WorkerEntrypoint<Env> {
	async submitWake(input: OperatorWake): Promise<{ accepted: true } | { accepted: false; message: string }> {
		if (this.env.OPERATOR_PAUSED === "true") return { accepted: false, message: "The operator worker is paused." };
		if (!input || typeof input.workItemId !== "string" || !/^[0-9a-f-]{36}$/iu.test(input.workItemId)
			|| !Number.isSafeInteger(input.version) || input.version < 1
			|| !Number.isSafeInteger(input.turn) || input.turn < 1
			|| typeof input.wakeKey !== "string" || !input.wakeKey
			|| typeof input.state !== "string") {
			return { accepted: false, message: "The wake is outside the operator contract." };
		}
		return this.env.OPERATOR_TURN.getByName(input.workItemId).acceptWake(input);
	}
}

/**
 * One Durable Object per work item: serialized turns, a persisted transcript,
 * and alarm-driven crash resume. The ledger stays the sole durable authority;
 * this object owns only the conversation and its budgets.
 */
export class OperatorTurn extends DurableObject<Env> {
	async acceptWake(wake: OperatorWake): Promise<{ accepted: true } | { accepted: false; message: string }> {
		const prior = await this.ctx.storage.get<TurnOutcome>(`outcome:${wake.wakeKey}`);
		if (prior) return { accepted: true };
		const current = await this.ctx.storage.get<TurnState>("turn");
		if (current?.status === "running") {
			if (current.wakeKey === wake.wakeKey) return { accepted: true };
			return { accepted: false, message: "An operator turn is already in flight for this work item." };
		}
		const snapshot = parseSnapshot(wake.state);
		const turn: TurnState = {
			wakeKey: wake.wakeKey,
			workItemId: wake.workItemId,
			wakeVersion: wake.version,
			turnNumber: wake.turn,
			version: snapshot.version ?? wake.version,
			leaseId: typeof snapshot.leaseId === "string" ? snapshot.leaseId : null,
			activeRunId: snapshot.activeImplementation?.runId ?? "",
			planBranch: snapshot.plan?.branch ?? "",
			issueNumber: Number.isSafeInteger(snapshot.artifacts?.issue?.number) ? snapshot.artifacts!.issue!.number! : 0,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `State: ${wake.state}` },
			],
			toolCalls: 0,
			tokens: 0,
			startedAt: Date.now(),
			status: "running",
			calls: [],
		};
		// Durable before any model call, so a restart resumes instead of
		// restarting; the alarm is both the driver and the crash backstop.
		await this.ctx.storage.put("turn", turn);
		await this.ctx.storage.setAlarm(Date.now());
		return { accepted: true };
	}

	async alarm(): Promise<void> {
		const turn = await this.ctx.storage.get<TurnState>("turn");
		if (!turn) return;
		if (turn.status === "done") {
			if (turn.noteDue) await this.deliverNote(turn);
			return;
		}
		if (Date.now() - turn.startedAt > TURN_WALL_CLOCK_MS) {
			await this.finish(turn, "PARKED:time-budget");
			return;
		}
		await this.ctx.storage.setAlarm(Date.now() + TURN_ALARM_BACKSTOP_MS);
		await this.drive(turn);
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
				? { status: turn.status, wakeKey: turn.wakeKey, turnNumber: turn.turnNumber, toolCalls: turn.toolCalls, tokens: turn.tokens, startedAt: turn.startedAt, outcome: turn.outcome ?? null, calls: turn.calls }
				: null,
			recentTurns: recent ?? [],
			spendToday: spend ?? { turns: 0, toolCalls: 0, tokens: 0 },
		};
	}

	private async drive(turn: TurnState): Promise<void> {
		while (turn.status === "running") {
			// Resume a tool call interrupted mid-execution: the persisted pending
			// record replays the identical command, and the ledger's effect keys
			// return the existing action rather than double-executing.
			if (turn.pending) {
				const ended = await this.performPending(turn);
				if (ended) return;
				continue;
			}
			if (turn.toolCalls >= Number(this.env.MAX_TOOL_CALLS_PER_TURN)) return this.finish(turn, "PARKED:tool-budget");
			if (turn.tokens >= Number(this.env.MAX_TOKENS_PER_TURN)) return this.finish(turn, "PARKED:token-budget");
			if (Date.now() - turn.startedAt > TURN_WALL_CLOCK_MS) return this.finish(turn, "PARKED:time-budget");

			let reply;
			try {
				reply = await withRetry(() => callModel(this.env, turn.messages, TOOLS, Number(this.env.MAX_TOKENS_PER_TURN) - turn.tokens), {
					attempts: 3,
					baseMs: 500,
					retryOn: (error) => (error instanceof ModelError && (error.status === 429 || error.status >= 500)) || error instanceof TypeError,
				});
			} catch (error) {
				// A dead provider is not a work-item failure: park this turn and let
				// the ledger's bounded wake retry re-drive it later.
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

	private async performPending(turn: TurnState): Promise<boolean> {
		const pending = turn.pending!;
		const result = await this.invokeTool(turn, pending);
		turn.messages.push({ role: "tool", tool_call_id: pending.callId, content: JSON.stringify(result).slice(0, TOOL_RESULT_MAX_CHARS) });
		const failure = (result as { error?: unknown }).error;
		turn.calls.push({ name: pending.name, ok: failure === undefined, ...(typeof failure === "string" ? { error: failure.slice(0, 200) } : {}) });
		turn.pending = undefined;
		await this.ctx.storage.put("turn", turn);
		if (PARKING_TOOLS.has(pending.name) && (result as { state?: unknown }).state === "completed") {
			await this.finish(turn, "PARKED:operator-exit");
			return true;
		}
		return false;
	}

	private async invokeTool(turn: TurnState, pending: NonNullable<TurnState["pending"]>): Promise<Record<string, unknown>> {
		const { name, args, minted } = pending;
		try {
			if (OBSERVATION_TOOLS.has(name)) {
				switch (name) {
					case "getMainSha": return { ...await this.env.GITHUB.getMainSha() };
					case "getCandidate": return { candidate: await this.env.GITHUB.getCandidate(args as { branch: string; pullRequestBase: string }) };
					case "observeCandidateValidation": return { validation: await this.env.GITHUB.observeCandidateValidation(args as { pullRequest: number; headSha: string }) };
					case "findPromotionRun": return { run: await this.env.GITHUB.findPromotionRun({ dispatchKey: String(args.dispatchKey), ...(typeof args.createdAfter === "string" ? { createdAfter: args.createdAfter } : {}) }) };
					case "inspectPromotionRun": return { ...await this.env.GITHUB.observeWorkflowRun(args as { runId: number }) };
					case "inspectImplementation": return { run: await this.env.RUNNER.inspectRun({ jobId: turn.workItemId, generation: Number(args.generation), runId: String(args.runId) }) };
				}
			}
			const command = commandFor(name, args, {
				leaseId: turn.leaseId,
				minted,
				activeRunId: turn.activeRunId,
				planBranch: turn.planBranch,
				issueNumber: turn.issueNumber,
			});
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
			// 2. Claim execution under the same token and lease protocol.
			const begun = await this.env.LEDGER.beginOperatorAction({ actionId: staged.id });
			if (begun.disposition !== "execute" || !begun.executionToken) {
				if (begun.action.status === "applied") await this.absorbAppliedAction(turn, command, begun.action);
				return summarizeAction(begun.action);
			}
			// 3. Execute against the private capabilities, then record the truth.
			try {
				const result = await executeCommand(this.env, begun.workItem, begun.action.command);
				const done = await this.env.LEDGER.completeOperatorAction({ actionId: staged.id, idempotencyKey: begun.action.idempotencyKey, executionToken: begun.executionToken, result });
				this.absorbReceipt(turn, command, result);
				await this.ctx.storage.put("turn", turn);
				return summarizeAction(done);
			} catch (error) {
				// The rejection carries the reason into the ledger and back to the
				// model in the same turn.
				const message = error instanceof Error ? error.message : String(error);
				const rejected = await this.env.LEDGER.rejectOperatorAction({ actionId: staged.id, executionToken: begun.executionToken, error: message });
				return summarizeAction(rejected);
			}
		} catch (error) {
			// Tool-level failure is data, not a crash: the model sees it and corrects.
			return { error: String(error instanceof Error ? error.message : error).slice(0, 300) };
		}
	}

	/** A replayed or reconciled applied action carries its receipt as a JSON string. */
	private async absorbAppliedAction(turn: TurnState, command: { kind: string; leaseId?: string; runId?: string }, action: { result?: unknown }): Promise<void> {
		if (action.result === undefined || action.result === null) return;
		try {
			this.absorbReceipt(turn, command, typeof action.result === "string" ? JSON.parse(action.result) : action.result);
			await this.ctx.storage.put("turn", turn);
		} catch { /* an unparseable receipt leaves the turn state as it was */ }
	}

	/** Keep the loop-owned staging facts current as receipts arrive. */
	private absorbReceipt(turn: TurnState, command: { kind: string; leaseId?: string; runId?: string }, result: unknown): void {
		const receipt = result as { version?: unknown; ledger?: { version?: unknown } };
		const version = Number.isSafeInteger(receipt?.version) ? receipt.version as number : Number.isSafeInteger(receipt?.ledger?.version) ? receipt.ledger!.version as number : undefined;
		if (version !== undefined) turn.version = version;
		if (command.kind === "claim" && typeof command.leaseId === "string") turn.leaseId = command.leaseId;
		if (command.kind === "release" || command.kind === "defer") turn.leaseId = null;
		if (command.kind === "implement" && typeof command.runId === "string") turn.activeRunId = command.runId;
	}

	private async finish(turn: TurnState, outcome: string): Promise<void> {
		const endedAt = Date.now();
		turn.status = "done";
		turn.outcome = outcome;
		turn.noteDue = true;
		turn.noteAttempts = 0;
		const record: TurnOutcome = { outcome, toolCalls: turn.toolCalls, tokens: turn.tokens, endedAt };
		const day = new Date().toISOString().slice(0, 10);
		const spend = (await this.ctx.storage.get<{ turns: number; toolCalls: number; tokens: number }>(`spend:${day}`)) ?? { turns: 0, toolCalls: 0, tokens: 0 };
		const recent = (await this.ctx.storage.get<Array<Record<string, unknown>>>("recent-turns")) ?? [];
		recent.push({ turnNumber: turn.turnNumber, wakeKey: turn.wakeKey, outcome, toolCalls: turn.toolCalls, tokens: turn.tokens, endedAt, calls: turn.calls });
		await Promise.all([
			this.ctx.storage.put("turn", turn),
			this.ctx.storage.put(`outcome:${turn.wakeKey}`, record),
			this.ctx.storage.put(`spend:${day}`, { turns: spend.turns + 1, toolCalls: spend.toolCalls + turn.toolCalls, tokens: spend.tokens + turn.tokens }),
			this.ctx.storage.put("recent-turns", recent.slice(-RECENT_TURNS_KEPT)),
		]);
		await this.deliverNote(turn);
	}

	/**
	 * Settle the demo's durable wake record. This replaces the RpcStub
	 * onGadgetResponse hop with one plain LedgerService RPC; a failed delivery
	 * retries briefly, then the wake's bounded response lease recovers it.
	 */
	private async deliverNote(turn: TurnState): Promise<void> {
		let delivered = false;
		try {
			await this.env.LEDGER.recordOperatorNote({
				workItemId: turn.workItemId,
				expectedVersion: turn.wakeVersion,
				turn: turn.turnNumber,
				response: { text: turn.outcome ?? "PARKED:no-outcome", idempotencyKey: noteKey(turn.wakeKey) },
			});
			delivered = true;
		} catch { /* handled below against current storage */ }
		// The RPC await can interleave with a freshly accepted wake; only the
		// still-current turn may touch stored state or the alarm.
		const current = await this.ctx.storage.get<TurnState>("turn");
		if (!current || current.wakeKey !== turn.wakeKey || current.status !== "done") return;
		if (delivered) {
			await this.ctx.storage.put("turn", { ...current, noteDue: false });
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const noteAttempts = (current.noteAttempts ?? 0) + 1;
		await this.ctx.storage.put("turn", { ...current, noteAttempts });
		// Past the retry budget the demo's bounded wake redelivery recovers.
		if (noteAttempts <= NOTE_ATTEMPT_BUDGET) await this.ctx.storage.setAlarm(Date.now() + NOTE_RETRY_MS);
		else await this.ctx.storage.deleteAlarm();
	}
}

function noteKey(wakeKey: string): string {
	// The wake key is already unique per (work item, revision, turn); it only
	// needs the ledger's bounded note-key alphabet.
	const safe = wakeKey.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 192);
	return /^[A-Za-z0-9]/u.test(safe) ? safe : `k${safe.slice(0, 191)}`;
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
	if (/^(?:PROGRESSED|PARKED:[A-Za-z0-9._-]+|COMPLETE)$/u.test(text)) return text;
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
		return Response.json(await env.OPERATOR_TURN.getByName(match[1].toLowerCase()).status());
	},
} satisfies ExportedHandler<Env>;

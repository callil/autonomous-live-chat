import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
	AccountDescription,
	ActionKind,
	ApprovalQueue,
	Gatekeeper,
	GatekeeperConnectCallback,
	GatekeeperConnectOptions,
	GatekeeperUser,
	GatekeeperUserVerifier,
	ResourceConfiguratorFrame,
	ResourceDescription,
	SupportedResource,
	VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AppHarnessLedger, GitHubRepository, NativeGitRunner } from "./operator-gatekeeper.contract";
import type { ClassificationInput, LedgerClassification, LedgerWorkItem, OperatorCommand, OperatorSession, StagedActionResult } from "./types";

const ICON = {
	url: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='18'><path d='M48 44h160v168H48z'/><path d='M78 92h100M78 128h100M78 164h64'/><path d='m181 178 17 17 34-42'/></svg>"),
};

/** The one Cloudflare OS approval kind for every model-selected ledger command. */
export const APPLY_OPERATOR_COMMAND_ACTION = {
	tag: "apply-app-harness-operator-command",
	label: "Apply App Harness operator command",
} satisfies ActionKind;

type SessionApprovalQueue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> &
	Partial<{ [Symbol.dispose](): void }>;

const TYPES_CODE = `
interface AppHarnessOperator {
  listReady(input?: { limit?: number }): Promise<LedgerWorkItem[]>;
  getWorkItem(input: { workItemId: string }): Promise<LedgerWorkItem | null>;
  getAction(input: { actionId: number }): Promise<StagedOperatorAction | null>;
  listActions(input: { workItemId: string }): Promise<StagedOperatorAction[]>;
  inspectImplementation(input: { jobId: string; generation: number; runId: string }): Promise<unknown>;
  getMainSha(): Promise<{ sha: string }>;
  getCandidate(input: { branch: string; pullRequestBase: string }): Promise<{ number: number; url: string; headSha: string; base: string; state: string } | null>;
  observeCandidateValidation(input: { pullRequest: number; headSha: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
  findPromotionRun(input: { dispatchKey: string; createdAfter?: string }): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null>;
  inspectPromotionRun(input: { runId: number }): Promise<{ runId: number; status: string; conclusion: string | null; url: string }>;
  stageClaim(input: ClaimInput): Promise<StagedActionResult>;
  stageRelease(input: ReleaseInput): Promise<StagedActionResult>;
  stageClassification(input: ClassificationInput): Promise<StagedActionResult>;
  stagePlan(input: PlanInput): Promise<StagedActionResult>;
  stageIssue(input: IssueInput): Promise<StagedActionResult>;
  stageImplementation(input: ImplementationInput): Promise<StagedActionResult>;
  stageCandidate(input: CandidateInput): Promise<StagedActionResult>;
  stagePromotion(input: PromotionInput): Promise<StagedActionResult>;
  stageState(input: StateInput): Promise<StagedActionResult>;
  stageDefer(input: DeferInput): Promise<StagedActionResult>;
}
// Read a work item, then select the appropriate action. This binding does not infer a next action.
type LedgerWorkItem = { id: string; version: number; phase: string; request: unknown; lease: { operatorId: string; id: string; expiresAt: number } | null; classification: Record<string, unknown> | null; plan: LedgerPlan | null; activeImplementation?: { key: string; runId: string; attempt: number; startedAt: number } | null; artifacts: Record<string, unknown> };
type LedgerPlan = { revision: number; baseSha: string; stackId: string; generation: number; nodeId: "root"; branch: string; parentBranch: "main"; parentBaseSha: string; pullRequestBase: "main"; issueNumber: number; summary: unknown; ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure" };
type StagedOperatorAction = { id: number; workItemId: string; expectedVersion: number; idempotencyKey: string; command: unknown; status: string; executionToken?: string; result?: unknown };
type StagedActionResult = { actionId: number; workItemId: string; state: "queued" | "already-queued" | "completed" | "rejected"; error?: string };
type Common = { workItemId: string; expectedVersion: number; leaseId: string };
type ClaimInput = { workItemId: string; expectedVersion: number; leaseId: string; leaseMs: number };
type ReleaseInput = Common;
type LedgerClassification = {
  decision: "eligible" | "needs_review" | "rejected";
  changeType: "visual" | "content" | "data" | "behavior" | "infrastructure";
  scope: "localized" | "bounded" | "broad";
  risk: "low" | "medium" | "high";
  affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure";
  reversible: boolean;
  executionEligibility: "eligible" | "needs_review";
  ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure";
};
// These fields are flat so Cloudflare OS never has to guess an opaque nested
// Cap'n Web union. The runtime validates the same values shown here.
type ClassificationInput = Common & LedgerClassification & { message: string };
type PlanInput = Common & { plan: LedgerPlan; message: string };
type IssueInput = Common & { title: string; body: string; classification: "triage" | "agent" | "needs-review" | "rejected" | "deployed" };
// runId is the ledger's stable logical implementation identifier. Reuse it for CandidateInput; inspectImplementation uses the distinct process runId returned by stageImplementation's action receipt.
type ImplementationInput = Common & { runId: string };
type CandidateInput = Common & { runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string };
type PromotionInput = Common & { pullRequestNumber: number; headSha: string; dispatchKey: string };
type StateInput = Common & { phase: "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected"; artifacts?: Record<string, unknown>; message: string; source: "cloudflare-os" | "github" | "runner" | "ci" | "system" };
type DeferInput = Common & { delayMs: number; message: string };
`;

function commandTitle(command: OperatorCommand): string {
	return `App Harness: ${command.kind.replaceAll("-", " ")}`;
}

function commandDescription(workItemId: string, command: OperatorCommand): string {
	return `Apply Cloudflare OS's selected \`${command.kind}\` command for App Harness work item \`${workItemId}\`. The App Harness durable ledger, not this Gatekeeper, stores the command, lease, retries, and result.`;
}

function stageState(status: "staged" | "applying" | "applied" | "rejected" | "needs_reconciliation"): StagedActionResult["state"] {
	if (status === "applied") return "completed";
	if (status === "rejected") return "rejected";
	return status === "staged" ? "queued" : "already-queued";
}

/**
 * The only agent-facing App Harness API. Read operations are observations;
 * every mutation is an explicit, model-selected command staged in LedgerService
 * before it reaches Cloudflare OS's approval mechanism.
 */
@validateRpc()
export class AppHarnessOperatorSession extends RpcTarget implements OperatorSession {
	constructor(
		private readonly approvals: SessionApprovalQueue,
		private readonly ledger: AppHarnessLedger,
		private readonly runner: NativeGitRunner,
		private readonly github: GitHubRepository,
	) { super(); }

	async listReady(input?: { limit?: number }) {
		await this.observe("Read ready App Harness work", "Read durable work items ready for the persistent Cloudflare OS operator.");
		return this.ledger.listReady(input);
	}

	async getWorkItem(input: { workItemId: string }) {
		await this.observe("Read App Harness work item", "Read one durable App Harness work item and its current public artifacts.");
		return this.ledger.getWorkItem(input);
	}

	async getAction(input: { actionId: number }) {
		await this.observe("Read staged App Harness command", "Read a command previously staged in the sole App Harness durable ledger.");
		return this.ledger.getOperatorAction(input);
	}

	async listActions(input: { workItemId: string }) {
		await this.observe("Reconcile App Harness commands", "Read every durable command for one work item, including commands that need reconciliation after an interrupted execution.");
		return this.ledger.listOperatorActions(input);
	}

	async inspectImplementation(input: { jobId: string; generation: number; runId: string }): Promise<unknown> {
		await this.observe("Inspect isolated implementation", "Read the current result of a bounded Cloudflare Sandbox/NanoCodex run.");
		return this.runner.inspectRun(input);
	}

	async getMainSha() {
		await this.observe("Read repository base revision", "Read the current immutable main revision from the repository-scoped GitHub App.");
		return this.github.getMainSha();
	}

	async getCandidate(input: { branch: string; pullRequestBase: string }) {
		await this.observe("Read stack candidate", "Read an existing stack pull request without changing it.");
		return this.github.getCandidate(input);
	}

	async observeCandidateValidation(input: { pullRequest: number; headSha: string }) {
		await this.observe("Inspect candidate validation", "Read the trusted candidate CI run bound to an exact pull request and immutable head revision.");
		return this.github.observeCandidateValidation(input);
	}

	async findPromotionRun(input: { dispatchKey: string; createdAfter?: string }) {
		await this.observe("Find promotion run", "Read the deterministic GitHub Actions promotion run for a stack node.");
		return this.github.findPromotionRun(input);
	}

	async inspectPromotionRun(input: { runId: number }) {
		await this.observe("Inspect promotion run", "Read the status of a GitHub Actions promotion run.");
		return this.github.observeWorkflowRun(input);
	}

	stageClaim(input: Parameters<OperatorSession["stageClaim"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "claim", leaseId: input.leaseId, leaseMs: input.leaseMs }); }
	stageRelease(input: Parameters<OperatorSession["stageRelease"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "release", leaseId: input.leaseId }); }
	stageClassification(input: Parameters<OperatorSession["stageClassification"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "classify", leaseId: input.leaseId, classification: classificationFromInput(input), message: input.message }); }
	stagePlan(input: Parameters<OperatorSession["stagePlan"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "plan", leaseId: input.leaseId, plan: input.plan, message: input.message }); }
	stageIssue(input: Parameters<OperatorSession["stageIssue"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "create-issue", leaseId: input.leaseId, title: input.title, body: input.body, classification: input.classification }); }
	stageImplementation(input: Parameters<OperatorSession["stageImplementation"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "implement", leaseId: input.leaseId, runId: input.runId }); }
	stageCandidate(input: Parameters<OperatorSession["stageCandidate"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "record-candidate", leaseId: input.leaseId, runId: input.runId, branch: input.branch, headSha: input.headSha, pullRequestNumber: input.pullRequestNumber, pullRequestUrl: input.pullRequestUrl, message: input.message }); }
	stagePromotion(input: Parameters<OperatorSession["stagePromotion"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "promote", leaseId: input.leaseId, pullRequestNumber: input.pullRequestNumber, headSha: input.headSha, dispatchKey: input.dispatchKey }); }
	stageState(input: Parameters<OperatorSession["stageState"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "record-state", leaseId: input.leaseId, phase: input.phase, artifacts: input.artifacts, message: input.message, source: input.source }); }
	stageDefer(input: Parameters<OperatorSession["stageDefer"]>[0]) { return this.stage(input.workItemId, input.expectedVersion, { kind: "defer", leaseId: input.leaseId, delayMs: input.delayMs, message: input.message }); }

	private async observe(title: string, description: string): Promise<void> {
		await this.approvals.authorizeObservation({ title, description });
	}

	private async stage(workItemId: string, expectedVersion: number, command: OperatorCommand): Promise<StagedActionResult> {
		const staged = await this.ledger.stageOperatorAction({ workItemId, expectedVersion, command });
		if (staged.status === "applied" || staged.status === "rejected") {
			return this.stagedResult(staged, workItemId);
		}
		try {
			await this.approvals.submitAction(staged.id, {
				title: commandTitle(command),
				description: commandDescription(workItemId, command),
				implementsRevert: false,
				actionKind: APPLY_OPERATOR_COMMAND_ACTION,
				autoApprovable: true,
				awaitDecision: true,
			});
		} catch {
			await this.rejectStagedAction(staged.id);
			throw new Error("Cloudflare OS could not submit the durable App Harness command for approval.");
		}
		// Wait briefly for the auto-approved apply so one operator turn can
		// advance several consecutive steps against real outcomes. The durable
		// ledger remains the authority; on timeout the caller sees "queued".
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const settled = await this.ledger.getOperatorAction({ actionId: staged.id });
			if (settled && (settled.status === "applied" || settled.status === "rejected")) return this.stagedResult(settled, workItemId);
			await scheduler.wait(250);
		}
		const current = await this.ledger.getOperatorAction({ actionId: staged.id });
		return this.stagedResult(current ?? staged, workItemId);
	}

	private stagedResult(action: { id: number; status: "staged" | "applying" | "applied" | "rejected" | "needs_reconciliation"; result?: unknown }, workItemId: string): StagedActionResult {
		const failure = action.status === "rejected" && action.result && typeof action.result === "object" && typeof (action.result as { error?: unknown }).error === "string"
			? String((action.result as { error: string }).error).slice(0, 300)
			: undefined;
		return { actionId: action.id, workItemId, state: stageState(action.status), ...(failure ? { error: failure } : {}) };
	}

	[Symbol.dispose](): void { this.approvals[Symbol.dispose]?.(); }

	private async rejectStagedAction(actionId: number): Promise<void> {
		const begun = await this.ledger.beginOperatorAction({ actionId });
		if (begun.disposition === "execute" && begun.executionToken) {
			await this.ledger.rejectOperatorAction({ actionId, executionToken: begun.executionToken });
		}
	}
}

/**
 * Stateless Gatekeeper DO. It has no KV, SQL, cache, alarm, retry queue, or
 * action map. Cloudflare OS owns approval state; LedgerService owns every
 * App Harness action and its outcome.
 */
@validateRpc()
export class AppHarnessOperatorGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<AppHarnessOperatorSession> {
	private ledger(): AppHarnessLedger { return this.env.LEDGER as unknown as AppHarnessLedger; }
	private runner(): NativeGitRunner { return this.env.RUNNER as unknown as NativeGitRunner; }
	private github(): import("./operator-gatekeeper.contract").GitHubRepository { return this.env.GITHUB as unknown as import("./operator-gatekeeper.contract").GitHubRepository; }
	async describe(): Promise<ResourceDescription> {
		return {
			url: "app-harness://operator",
			title: "App Harness operator",
			snippet: "Observe durable work and stage model-selected App Harness commands.",
			suggestedBindingName: "APP_HARNESS",
			tsType: "AppHarnessOperator",
		};
	}

	async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
	async getAutoApprovableActions(): Promise<ActionKind[]> { return [APPLY_OPERATOR_COMMAND_ACTION]; }
	async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<AppHarnessOperatorSession> {
		return new AppHarnessOperatorSession(approvalQueue.dup(), this.ledger(), this.runner(), this.github());
	}
	async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
	async removeObserver(_id: string): Promise<void> {}

	async applyAction(actionId: number): Promise<void> {
		const begun = await this.ledger().beginOperatorAction({ actionId });
		if (begun.disposition !== "execute" || !begun.executionToken) return;
		try {
			const result = await this.execute(begun.workItem, begun.action.command);
			await this.ledger().completeOperatorAction({ actionId, idempotencyKey: begun.action.idempotencyKey, executionToken: begun.executionToken, result });
		} catch (error) {
			// Reject with the failure recorded so the durable ledger frees the
			// work item and the next operator turn sees exactly what to correct.
			// The Gatekeeper still invents no retry policy of its own.
			const message = error instanceof Error ? error.message : String(error);
			try {
				await this.ledger().rejectOperatorAction({ actionId, executionToken: begun.executionToken, error: message });
			} catch { /* the apply lease recovers through ledger reconciliation */ }
			throw error;
		}
	}

	async rejectAction(actionId: number): Promise<void> {
		const begun = await this.ledger().beginOperatorAction({ actionId });
		if (begun.disposition === "execute" && begun.executionToken) {
			await this.ledger().rejectOperatorAction({ actionId, executionToken: begun.executionToken });
		}
	}
	async revertAction(_actionId: number): Promise<void> { throw new Error("The operator must stage a compensating command in the durable ledger."); }

	private async execute(workItem: LedgerWorkItem, command: OperatorCommand): Promise<unknown> {
		switch (command.kind) {
			case "claim": return workItemReceipt(await this.ledger().claim({ workItemId: workItem.id, leaseId: command.leaseId, leaseMs: command.leaseMs }));
			case "release": return workItemReceipt(await this.ledger().release({ workItemId: workItem.id, leaseId: command.leaseId }));
			case "classify": {
				if (workItem.artifacts.issue !== undefined) {
					const issueNumber = issueNumberFrom(workItem);
					await this.github().updateClassification({ issueNumber, classification: githubClassificationForDecision(command.classification.decision), modelClassification: asModelClassification(command.classification) });
					await this.github().postStatus({ issueNumber, eventId: `${workItem.id}-accepted`, body: command.classification.decision === "eligible" ? "### Accepted\n\nCloudflare OS classified this request and admitted it to the autonomous repository workflow." : `### ${statusHeading(command.classification.decision)}\n\n${command.message}` });
				}
				return workItemReceipt(await this.ledger().recordClassification({ workItemId: workItem.id, leaseId: command.leaseId, classification: command.classification, message: command.message }));
			}
			case "plan": {
				await this.postIssueStatus(workItem, "planned", command.message);
				return workItemReceipt(await this.ledger().recordPlan({ workItemId: workItem.id, leaseId: command.leaseId, plan: command.plan, message: command.message }));
			}
			case "create-issue": {
				const issue = await this.github().createIssue({ eventId: workItem.id, title: command.title, body: command.body, classification: asGitHubClassification(command.classification) });
				if (!workItem.classification) throw new Error("A GitHub issue command requires the durable classification.");
				await this.github().updateClassification({ issueNumber: issue.issueNumber, classification: "agent", modelClassification: asModelClassification(workItem.classification) });
				await this.github().postStatus({ issueNumber: issue.issueNumber, eventId: `${workItem.id}-accepted`, body: "### Accepted\n\nCloudflare OS classified this request and admitted it to the autonomous repository workflow." });
				const recorded = await this.ledger().recordArtifacts({
					workItemId: workItem.id,
					leaseId: command.leaseId,
					artifacts: { issue: { number: issue.issueNumber, url: issue.issueUrl } },
					message: issue.existing ? `Reconciled existing GitHub issue #${issue.issueNumber}.` : `Created GitHub issue #${issue.issueNumber}.`,
					source: "github",
				});
				return { issue: { number: issue.issueNumber, url: issue.issueUrl }, ledger: workItemReceipt(recorded) };
			}
			case "implement": {
				if (!workItem.plan || typeof workItem.request !== "string" || !workItem.request.trim()) throw new Error("An implementation command requires a durable plan and non-empty request.");
				const runner = await this.runner().startRun({
					jobId: workItem.id,
					repository: this.env.REPOSITORY,
					generation: workItem.plan.generation,
					candidate: {
						change: { kind: "repository-task", request: workItem.request },
						stack: {
							stackId: workItem.plan.stackId,
							nodeId: workItem.plan.nodeId,
							branch: workItem.plan.branch,
							parentBranch: workItem.plan.parentBranch,
							parentBaseSha: workItem.plan.parentBaseSha,
							pullRequestBase: workItem.plan.pullRequestBase,
							issueNumber: workItem.plan.issueNumber,
						},
					},
				});
				await this.postIssueStatus(workItem, "implementation", "### Building\n\nNanoCodex is editing the repository in an isolated Cloudflare Sandbox run.");
				const started = await this.ledger().startImplementation({ workItemId: workItem.id, leaseId: command.leaseId, runId: command.runId });
				return { disposition: started.disposition, implementationRunId: command.runId, ledger: workItemReceipt(started.item), runner };
			}
			case "record-candidate": {
				await this.postIssueStatus(workItem, "candidate", `### Pull request ready\n\n[PR #${command.pullRequestNumber}](${command.pullRequestUrl}) is the root node of this request's one-node stack. Candidate CI is running against immutable head \`${command.headSha}\`.`);
				return workItemReceipt(await this.ledger().recordCandidate({ workItemId: workItem.id, leaseId: command.leaseId, runId: command.runId, branch: command.branch, headSha: command.headSha, pullRequestNumber: command.pullRequestNumber, pullRequestUrl: command.pullRequestUrl, message: command.message }));
			}
			case "promote": {
				if (!workItem.plan) throw new Error("A promotion command requires the durable stack plan.");
				const dispatched = await this.github().dispatchPromotion({
					pullRequest: command.pullRequestNumber,
					stackId: workItem.plan.stackId,
					generation: workItem.plan.generation,
					issueNumber: workItem.plan.issueNumber,
					parentBranch: workItem.plan.parentBranch,
					headSha: command.headSha,
					dispatchKey: command.dispatchKey,
					ciProfile: asCiProfile(workItem.plan.ciProfile),
				});
				await this.postIssueStatus(workItem, "promotion", "### Promotion requested\n\nTrusted GitHub Actions is revalidating the exact candidate against current `main`, then will merge and deploy it under the global promotion lock.");
				return dispatched;
			}
			case "record-state": {
				if (command.phase === "completed") {
					const issueNumber = issueNumberFrom(workItem);
					const deploymentUrl = deploymentUrlFrom(workItem, command.artifacts);
					await this.github().closeAfterDeployment({ issueNumber, eventId: `${workItem.id}-completed`, body: command.message, deploymentUrl });
				} else {
					await this.postIssueStatus(workItem, command.phase, `### ${statusHeading(command.phase)}\n\n${command.message}`);
				}
				return workItemReceipt(await this.ledger().recordExternalState({ workItemId: workItem.id, leaseId: command.leaseId, phase: command.phase, artifacts: command.artifacts, message: command.message, source: command.source }));
			}
			case "defer": return workItemReceipt(await this.ledger().defer({ workItemId: workItem.id, leaseId: command.leaseId, delayMs: command.delayMs, message: command.message }));
		}
	}

	private async postIssueStatus(workItem: LedgerWorkItem, suffix: string, body: string): Promise<void> {
		const issue = workItem.artifacts.issue;
		if (!issue || typeof issue !== "object" || !Number.isSafeInteger((issue as { number?: unknown }).number)) return;
		await this.github().postStatus({ issueNumber: (issue as { number: number }).number, eventId: `${workItem.id}-${suffix}`, body });
	}
}

function workItemReceipt(item: LedgerWorkItem): { workItemId: string; version: number; phase: string } {
	return { workItemId: item.id, version: item.version, phase: item.phase };
}

function classificationFromInput(input: ClassificationInput): LedgerClassification {
	const classification = {
		decision: input.decision,
		changeType: input.changeType,
		scope: input.scope,
		risk: input.risk,
		affectedSurface: input.affectedSurface,
		reversible: input.reversible,
		executionEligibility: input.executionEligibility,
		ciProfile: input.ciProfile,
	};
	if (!["eligible", "needs_review", "rejected"].includes(classification.decision)) throw new Error("Classification decision must be eligible, needs_review, or rejected.");
	if (!["visual", "content", "data", "behavior", "infrastructure"].includes(classification.changeType)) throw new Error("Classification changeType is invalid.");
	if (!["localized", "bounded", "broad"].includes(classification.scope)) throw new Error("Classification scope is invalid.");
	if (!["low", "medium", "high"].includes(classification.risk)) throw new Error("Classification risk is invalid.");
	if (!["ui", "copy", "data", "behavior", "infrastructure"].includes(classification.affectedSurface)) throw new Error("Classification affectedSurface is invalid.");
	if (typeof classification.reversible !== "boolean") throw new Error("Classification reversible must be boolean.");
	if (!["eligible", "needs_review"].includes(classification.executionEligibility)) throw new Error("Classification executionEligibility is invalid.");
	if (!["visual", "content", "behavior", "data", "infrastructure"].includes(classification.ciProfile)) throw new Error("Classification ciProfile is invalid.");
	if (classification.decision === "eligible" && classification.executionEligibility !== "eligible") throw new Error("Eligible classification must be execution eligible.");
	if (classification.decision !== "eligible" && classification.executionEligibility === "eligible") throw new Error("A blocked classification cannot be execution eligible.");
	return classification as LedgerClassification;
}

function asGitHubClassification(value: string): "triage" | "agent" | "needs-review" | "rejected" | "deployed" {
	if (["triage", "agent", "needs-review", "rejected", "deployed"].includes(value)) return value as "triage" | "agent" | "needs-review" | "rejected" | "deployed";
	throw new Error("The staged GitHub issue classification is invalid.");
}

function githubClassificationForDecision(value: LedgerClassification["decision"]): "agent" | "needs-review" | "rejected" {
	if (value === "eligible") return "agent";
	return value === "needs_review" ? "needs-review" : "rejected";
}

function asCiProfile(value: string): "visual" | "content" | "behavior" | "data" | "infrastructure" {
	if (["visual", "content", "behavior", "data", "infrastructure"].includes(value)) return value as "visual" | "content" | "behavior" | "data" | "infrastructure";
	throw new Error("The staged plan has no supported CI profile.");
}

function asModelClassification(value: import("./types").LedgerClassification) {
	const classification = value as Record<string, unknown>;
	const result = {
		changeType: classification.changeType,
		scope: classification.scope,
		risk: classification.risk,
		affectedSurface: classification.affectedSurface,
		reversible: classification.reversible,
		executionEligibility: classification.executionEligibility,
		ciProfile: classification.ciProfile,
	};
	const valid = ["visual", "content", "data", "behavior", "infrastructure"].includes(String(result.changeType))
		&& ["localized", "bounded", "broad"].includes(String(result.scope))
		&& ["low", "medium", "high"].includes(String(result.risk))
		&& ["ui", "copy", "data", "behavior", "infrastructure"].includes(String(result.affectedSurface))
		&& typeof result.reversible === "boolean"
		&& ["eligible", "needs_review"].includes(String(result.executionEligibility))
		&& ["visual", "content", "behavior", "data", "infrastructure"].includes(String(result.ciProfile));
	if (!valid) throw new Error("The ledger classification cannot be projected to GitHub labels.");
	return result as Parameters<GitHubRepository["updateClassification"]>[0]["modelClassification"];
}

function statusHeading(phase: string): string {
	return ({ validating: "Candidate checks", promoting: "Promoting", deployed: "Deployed", retryable: "Retry scheduled", needs_review: "Needs review", rejected: "Rejected" } as Record<string, string>)[phase] ?? "Status update";
}

function issueNumberFrom(workItem: LedgerWorkItem): number {
	const issue = workItem.artifacts.issue;
	if (!issue || typeof issue !== "object" || !Number.isSafeInteger((issue as { number?: unknown }).number) || ((issue as { number: number }).number < 1)) {
		throw new Error("A completed work item requires its verified GitHub issue artifact.");
	}
	return (issue as { number: number }).number;
}

function deploymentUrlFrom(workItem: LedgerWorkItem, artifacts?: Record<string, unknown>): string {
	const value = artifacts?.deploymentUrl ?? workItem.artifacts.deploymentUrl;
	if (typeof value !== "string" || !value.startsWith("https://")) throw new Error("A completed work item requires its verified production deployment URL.");
	return value;
}

export function describeAppHarnessOperatorVendor(): VendorDescription {
	return {
		displayName: "App Harness",
		url: "https://github.com/callil/autonomous-live-chat",
		logo: ICON,
		color: "#e8f2ff",
		tagline: "Durable, model-operated App Harness repository work",
		description: "A thin Cloudflare OS capability over the App Harness ledger, repository identity, and isolated NanoCodex runner.",
		autoProvisionsAccount: true,
		providesAuth: false,
	};
}

@validateRpc()
export class AppHarnessOperatorAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
	async describe(): Promise<AccountDescription> { return { displayName: "App Harness", avatar: ICON, singleton: { tsType: "AppHarnessOperator" } }; }
	async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<AppHarnessOperatorSession>>> { return this.ctx.exports.AppHarnessOperatorGatekeeper({}); }
	async getSupportedResources(): Promise<SupportedResource[]> { return []; }
	getGatekeeperClassFor(_url: string): never { throw new Error("App Harness has no URL-addressed resources."); }
	startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("App Harness has no resource configurator."); }
	async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
	async revoke(): Promise<void> {}
	reconnect(): never { throw new Error("App Harness is auto-provisioned and has no reconnect flow."); }
	async getAuthenticatedEmail(): Promise<string | null> { return null; }
	@skipRpcValidation()
	async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.AppHarnessOperatorVerifier({}); }
}

@validateRpc()
export class AppHarnessOperatorVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier { verify(): void {} }

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
	async describe(): Promise<VendorDescription> { return describeAppHarnessOperatorVendor(); }
	@skipRpcValidation()
	async createAccount(): Promise<Fetcher<GatekeeperUser>> { return this.ctx.exports.AppHarnessOperatorAccount({}); }
	connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("App Harness is auto-provisioned and has no connect flow."); }
	async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return []; }
	async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

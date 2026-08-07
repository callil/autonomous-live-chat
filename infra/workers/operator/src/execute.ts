import type { AppHarnessLedger, GitHubRepositoryBinding, LedgerClassification, LedgerWorkItem, NativeGitRunnerBinding, OperatorCommand } from "./contracts";

export type ExecuteEnv = {
	LEDGER: AppHarnessLedger;
	RUNNER: NativeGitRunnerBinding;
	GITHUB: GitHubRepositoryBinding;
	REPOSITORY: string;
};

/**
 * The lifted AppHarnessOperatorGatekeeper.execute() switch: every durable
 * write goes through LedgerService, every external effect through the same
 * private RUNNER/GITHUB capabilities. This module still selects no next
 * command of its own.
 */
export async function executeCommand(env: ExecuteEnv, workItem: LedgerWorkItem, command: OperatorCommand): Promise<unknown> {
	switch (command.kind) {
		case "claim": return workItemReceipt(await env.LEDGER.claim({ workItemId: workItem.id, leaseId: command.leaseId, leaseMs: command.leaseMs }));
		case "release": return workItemReceipt(await env.LEDGER.release({ workItemId: workItem.id, leaseId: command.leaseId }));
		case "classify": {
			if (workItem.artifacts.issue !== undefined) {
				const issueNumber = issueNumberFrom(workItem);
				await env.GITHUB.updateClassification({ issueNumber, classification: githubClassificationForDecision(command.classification.decision), modelClassification: asModelClassification(command.classification) });
				await env.GITHUB.postStatus({ issueNumber, eventId: `${workItem.id}-accepted`, body: command.classification.decision === "eligible" ? "### Accepted\n\nThe operator classified this request and admitted it to the autonomous repository workflow." : `### ${statusHeading(command.classification.decision)}\n\n${command.message}` });
			}
			return workItemReceipt(await env.LEDGER.recordClassification({ workItemId: workItem.id, leaseId: command.leaseId, classification: command.classification, message: command.message }));
		}
		case "plan": {
			await postIssueStatus(env, workItem, "planned", command.message);
			return workItemReceipt(await env.LEDGER.recordPlan({ workItemId: workItem.id, leaseId: command.leaseId, plan: command.plan, message: command.message }));
		}
		case "create-issue": {
			const issue = await env.GITHUB.createIssue({ eventId: workItem.id, title: command.title, body: command.body, classification: command.classification });
			if (!workItem.classification) throw new Error("A GitHub issue command requires the durable classification.");
			await env.GITHUB.updateClassification({ issueNumber: issue.issueNumber, classification: "agent", modelClassification: asModelClassification(workItem.classification) });
			await env.GITHUB.postStatus({ issueNumber: issue.issueNumber, eventId: `${workItem.id}-accepted`, body: "### Accepted\n\nThe operator classified this request and admitted it to the autonomous repository workflow." });
			const recorded = await env.LEDGER.recordArtifacts({
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
			const runner = await env.RUNNER.startRun({
				jobId: workItem.id,
				repository: env.REPOSITORY,
				generation: workItem.plan.generation,
				// The ledger run identifier doubles as the bearer credential for
				// the runner's completion callback into the ledger.
				ledgerRunId: command.runId,
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
			await postIssueStatus(env, workItem, "implementation", "### Building\n\nNanoCodex is editing the repository in an isolated Cloudflare Sandbox run.");
			const started = await env.LEDGER.startImplementation({ workItemId: workItem.id, leaseId: command.leaseId, runId: command.runId });
			return { disposition: started.disposition, implementationRunId: command.runId, ledger: workItemReceipt(started.item), runner };
		}
		case "record-candidate": {
			await postIssueStatus(env, workItem, "candidate", `### Pull request ready\n\n[PR #${command.pullRequestNumber}](${command.pullRequestUrl}) is the root node of this request's one-node stack. Candidate CI is running against immutable head \`${command.headSha}\`.`);
			return workItemReceipt(await env.LEDGER.recordCandidate({ workItemId: workItem.id, leaseId: command.leaseId, runId: command.runId, branch: command.branch, headSha: command.headSha, pullRequestNumber: command.pullRequestNumber, pullRequestUrl: command.pullRequestUrl, message: command.message }));
		}
		case "promote": {
			if (!workItem.plan) throw new Error("A promotion command requires the durable stack plan.");
			const dispatched = await env.GITHUB.dispatchPromotion({
				pullRequest: command.pullRequestNumber,
				stackId: workItem.plan.stackId,
				generation: workItem.plan.generation,
				issueNumber: workItem.plan.issueNumber,
				parentBranch: workItem.plan.parentBranch,
				headSha: command.headSha,
				dispatchKey: command.dispatchKey,
				ciProfile: asCiProfile(workItem.plan.ciProfile),
			});
			await postIssueStatus(env, workItem, "promotion", "### Promotion requested\n\nTrusted GitHub Actions is revalidating the exact candidate against current `main`, then will merge and deploy it under the global promotion lock.");
			return dispatched;
		}
		case "record-state": {
			if (command.phase === "completed") {
				const issueNumber = issueNumberFrom(workItem);
				const deploymentUrl = deploymentUrlFrom(workItem, command.artifacts);
				await env.GITHUB.closeAfterDeployment({ issueNumber, eventId: `${workItem.id}-completed`, body: command.message, deploymentUrl });
			} else {
				await postIssueStatus(env, workItem, command.phase, `### ${statusHeading(command.phase)}\n\n${command.message}`);
			}
			return workItemReceipt(await env.LEDGER.recordExternalState({ workItemId: workItem.id, leaseId: command.leaseId, phase: command.phase, artifacts: command.artifacts, message: command.message, source: command.source }));
		}
		case "defer": return workItemReceipt(await env.LEDGER.defer({ workItemId: workItem.id, leaseId: command.leaseId, delayMs: command.delayMs, message: command.message }));
	}
}

async function postIssueStatus(env: ExecuteEnv, workItem: LedgerWorkItem, suffix: string, body: string): Promise<void> {
	const issue = workItem.artifacts.issue;
	if (!issue || typeof issue !== "object" || !Number.isSafeInteger((issue as { number?: unknown }).number)) return;
	await env.GITHUB.postStatus({ issueNumber: (issue as { number: number }).number, eventId: `${workItem.id}-${suffix}`, body });
}

function workItemReceipt(item: LedgerWorkItem): { workItemId: string; version: number; phase: string } {
	return { workItemId: item.id, version: item.version, phase: item.phase };
}

function githubClassificationForDecision(value: LedgerClassification["decision"]): "agent" | "needs-review" | "rejected" {
	if (value === "eligible") return "agent";
	return value === "needs_review" ? "needs-review" : "rejected";
}

function asCiProfile(value: string): "visual" | "content" | "behavior" | "data" | "infrastructure" {
	if (["visual", "content", "behavior", "data", "infrastructure"].includes(value)) return value as "visual" | "content" | "behavior" | "data" | "infrastructure";
	throw new Error("The staged plan has no supported CI profile.");
}

function asModelClassification(value: LedgerClassification) {
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
	return result as Parameters<GitHubRepositoryBinding["updateClassification"]>[0]["modelClassification"];
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

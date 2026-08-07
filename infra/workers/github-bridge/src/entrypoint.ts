import { WorkerEntrypoint } from "cloudflare:workers";
import { GitHubCapability, type CandidateObservationInput, type CandidateValidationObservationInput, type CloseAfterDeploymentInput, type CreateIssueInput, type DispatchPromotionInput, type GitHubBridgeEnv, type PostStatusInput, type PromotionRunObservationInput, type UpdateClassificationInput } from "./index";
import { handleGithubWebhook } from "./webhook";

/**
 * The only exported GitHub App capability.  This Worker is called over a
 * named private service binding; its public HTTP surface serves exactly one
 * route: the signed GitHub webhook receiver.  The App private key is resolved
 * only in this process.
 */
export class GitHubAppCapability extends WorkerEntrypoint<GitHubBridgeEnv> {
	private capability(): GitHubCapability {
		return new GitHubCapability(this.env);
	}

	createIssue(input: CreateIssueInput) { return this.capability().createIssue(input); }
	updateClassification(input: UpdateClassificationInput) { return this.capability().updateClassification(input); }
	postStatus(input: PostStatusInput) { return this.capability().postStatus(input); }
	closeAfterDeployment(input: CloseAfterDeploymentInput) { return this.capability().closeAfterDeployment(input); }
	getMainSha() { return this.capability().getMainSha(); }
	getCandidate(input: CandidateObservationInput) { return this.capability().getCandidate(input); }
	observeCandidateValidation(input: CandidateValidationObservationInput) { return this.capability().observeCandidateValidation(input); }
	dispatchPromotion(input: DispatchPromotionInput) { return this.capability().dispatchPromotion(input); }
	observeWorkflowRun(input: { runId: number }) { return this.capability().observeWorkflowRun(input); }
	findPromotionRun(input: PromotionRunObservationInput) { return this.capability().findPromotionRun(input); }
	createRunnerToken(input: { repository: string; jobId: string; generation: number }) { return this.capability().createRunnerToken(input); }
}

export default {
	async fetch(request: Request, env: GitHubBridgeEnv): Promise<Response> {
		if (new URL(request.url).pathname === "/github/webhook") {
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			return handleGithubWebhook(request, env);
		}
		return new Response("Not found", { status: 404 });
	},
};

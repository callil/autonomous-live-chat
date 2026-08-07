import { WorkerEntrypoint } from "cloudflare:workers";
import { GitHubCapability, type CandidateObservationInput, type CandidateValidationObservationInput, type CloseAfterDeploymentInput, type CreateIssueInput, type DispatchPromotionInput, type GitHubBridgeEnv, type PostStatusInput, type PromotionRunObservationInput, type UpdateClassificationInput } from "./index";

/**
 * The only exported GitHub App capability.  This Worker is called over a
 * named private service binding; its public HTTP surface intentionally does
 * nothing.  The App private key is resolved only in this process.
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
	fetch(): Response {
		return new Response("Not found", { status: 404 });
	},
};

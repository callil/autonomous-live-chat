# Next architecture: NanoCodex

The next step is a real model-driven coding agent, not a larger rule parser. [NanoCodex](https://github.com/gakonst/nanocodex) is the preferred candidate because it is a headless coding-agent SDK/CLI with an owned session, workspace tools, typed events, and OpenAI-backed model access.

The intended boundary is:

1. The Durable Object remains the authoritative room policy, queue, and public ledger.
2. A GitHub Actions job checks out an isolated candidate workspace for exactly this repository.
3. NanoCodex receives the scoped request, sanitized App Harness target envelope, and private target-to-source provenance manifest; it proposes or edits only inside that workspace and emits an auditable event stream.
4. Existing CI validates the candidate; the delivery policy decides whether it may be promoted and deployed.
5. The runner reports structured lifecycle events back to the Durable Object for all connected clients.

The deterministic transformer stays as a safe fallback for its tiny allowlist. It is not the coding agent.

## Credential prerequisite

NanoCodex needs OpenAI access inside the isolated hosted runner. The precise prerequisite is a securely stored GitHub repository secret named `OPENAI_API_KEY` from an OpenAI Platform project. Do not commit, print, or pass that secret through chat or browser code. A desktop Codex/ChatGPT login cannot be inherited by an ephemeral GitHub Actions runner.

Before enabling NanoCodex, keep the current prohibitions and add enforceable workspace, file-path, command, and promotion policies. The agent should never receive credentials beyond the scoped model key and the repository/deployment credentials already required by the validated CI path.

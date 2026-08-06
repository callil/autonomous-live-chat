# Safety and autonomy

App Harness gives the coding operator full repository access inside an isolated job. Safety is not a color-only transformer, file allowlist, or fake fixed patch generator.

The operator may change frontend, backend, data models, migrations, tests, dependencies, workflows, and Cloudflare infrastructure when the requested product outcome requires it. Its default focus is `apps/demo`; the repository structure helps it navigate responsibility without blocking coherent work.

## Operating guidelines

The agent must preserve user data and secrets and refuse work that is illegal, harmful, abusive, intentionally availability-destroying, destructive without an explicit recoverable plan, credential-seeking, or dependent on infrastructure it cannot truthfully provision. Database evolution should prefer additive schemas, compatibility windows, reversible migrations, backups where supported, and explicit validation of old data.

## Enforced boundaries

- disposable Sandbox per coding job;
- repository-scoped, short-lived GitHub installation identity;
- private key remains outside the child process;
- credentials scoped to the Git process rather than the whole shell session;
- immutable base/head provenance;
- unprivileged candidate CI;
- serialized stack promotion and deployment;
- signed, idempotent lifecycle callbacks;
- public issue, PR, and durable activity records.

These boundaries constrain authority and prove outcomes. They do not restrict legitimate source edits.

## Classification

The outer operator quickly classifies change type, scope, risk, affected surface, reversibility, execution eligibility, and CI profile. Classification chooses investigation and validation depth; it does not decide truth by itself. Even a tiny direct-looking change goes through a Git artifact and stack record so it remains attributable, revertible, and ordered against concurrent work.

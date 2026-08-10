# Safety and autonomy

App Harness gives the coding agent real repository access inside an isolated, disposable job. Safety is structural, not a color-only transformer, file allowlist theater, or fake fixed patch generator.

The agent may rewrite the product surface (`product/`) freely. It can never touch the frozen platform: the platform firewall fails any agent (`room/*`) diff that touches `platform/`, CI configuration, dependency manifests, lockfiles, or wrangler configs. New dependencies are human-gated by construction.

## Operating guidelines

The agent must preserve user data and secrets and refuse work that is illegal, harmful, abusive, intentionally availability-destroying, destructive without an explicit recoverable plan, credential-seeking, or dependent on infrastructure it cannot truthfully provision.

## Enforced boundaries

- disposable sandbox container per coding run, destroyed on completion;
- repository-scoped, short-lived GitHub installation token per dispatch; the App private key lives only in the platform Worker's secrets;
- the runner's in-container write policy denies the frozen platform paths;
- immutable head provenance: CI verdicts are read for the exact head SHA and the squash merge is refused if the branch moved after verification;
- binding-level isolation: the product Worker has no Durable Object bindings and no ledger access;
- the status surface (queue, feed, provenance links) is served by the frozen platform, so the agent cannot falsify reporting about its own builds;
- serialized deploys with exact-SHA `/version` observation, a post-deploy liveness watchdog, and an owner revert lever;
- public PR and durable activity records for every change.

These boundaries constrain authority and prove outcomes. They do not restrict legitimate source edits inside the product surface.

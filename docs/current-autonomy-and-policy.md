# Current autonomy and policy

The deployed fallback is intentionally narrow. It maps exact natural-language sentences to fixed, parameterized edits in `public/index.html`:

- `set accent to blue`, `green`, `purple`, or `orange`
- `set empty state to "Your short message"` — ordinary punctuation only, up to 80 characters

Any other request becomes **requires review**. Raw request text is never turned into a shell command, package command, configuration write, or arbitrary source edit.

Target mode can make either kind of request more legible by attaching its bounded element envelope. It does not expand the allowlist or grant the fallback any ability to interpret an arbitrary target as permission to modify arbitrary code.

Comments and drawings are durable intake, not a claim that freeform feedback is already self-executing. The Activity list records each submission and its triage state. Only a comment that exactly matches one of the fallback sentences is dispatched to the guarded candidate/CI/deploy loop; all other comments and every drawing remain **needs review** until the model-driven NanoCodex path is configured.

Hard prohibitions apply even to future agents unless an explicit policy revision is reviewed and shipped:

- destructive data changes or migrations;
- secrets, credentials, authentication, authorization, and policy changes;
- dependency, Worker configuration, or broad infrastructure changes;
- unbounded command execution or edits outside the project repository.

The candidate branch, pull request, checks, deployment, and durable room activity record form the audit trail. A successful fallback run is not evidence that the system can safely make arbitrary code changes.

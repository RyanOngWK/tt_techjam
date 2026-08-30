# Live Demo Script

Three-minute demo of **AgentGuard — Glass Box (trace and audit)**. One real
Agent run, shown first in its normal case, then with a real failure and
automatic recovery, then proving the platform is still controllable. The
middleware (span tree, redaction, detection, recovery, budget) is the story; the
baseline just carries it.

## Setup

```bash
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Open <http://localhost:3000>. Confirm the baseline acceptance task completes
once before relying on the demo.

## Demo

1. **Create or select an Agent.** Show its lifecycle state (ready/busy).
2. **Run a real task in the Playground.** Ask it to create a project, install
   dependencies, and run tests. The AgentGuard window auto-opens on the active
   run.
3. **Show the span tree (normal case).** In the **Trace** tab point out:
   - measured `TURN` spans with per-turn token usage
   - nested `MODEL_CALL` / `TOOL_CALL` spans with commands and real exit codes
   - checkpoints, budget/soft-limit spans
   - actor badges (human / agent / middleware)
   - expand a tool span to show redacted attributes; apply a category filter and
     the errors-only filter (tree stays nested, matches stay in place)
4. **Inject a real failure.** Kill the runtime container mid-run via **Inject
   failure → runtime_crash**. Codex exits non-zero and the tool span turns red
   on its own — no synthetic event.
5. **Detection in the tree.** `INCIDENT_OPENED` and `DIAGNOSIS_ISSUED` appear
   as children of the failing span, with evidence, confidence, and the exit-code
   signature.
6. **Recovery and verification.** `RECOVERY_STARTED` → `CHECKPOINT_RESTORED`
   nest under the same failing span; the next `TURN` contains
   `RECOVERY_VERIFIED`; the run completes. Point out `attemptIndex`
   distinguishing the redone work.
7. **Trace drives control (optional, brief).** Show the budget meter and a
   mid-turn `BUDGET_PROJECTED_EXCEED` decided from accumulated span data, or
   inject `budget_exceeded` → Approve/Abort HITL with the approval attributed to
   actor `human`.
8. **Audit and export.** Open the **Runs** tab to show every run across agents;
   export the trace as JSON and note no secret material appears.
9. **Platform still controllable.** Send a follow-up message that continues the
   session and workspace.

## LLM Wiki on large tasks

Every created Agent now carries an **LLM Wiki** workflow: when a task is deemed
large, it scaffolds and maintains `wiki/` in its workspace to manage the code,
and delegates heavier upkeep to a `@wikier` subagent.

1. **Create or select an Agent.** No extra configuration — the platform-written
   `AGENTS.md` embeds the trigger and the `wikier` custom agent is pre-seeded at
   `.codex/agents/wikier.toml`.
2. **Ask for something big.** Type "build a to-do app". The Agent deems it large
   and scaffolds `wiki/` before writing code.
3. **Show the wiki.** Open the workspace
   (`workspaces/<agent-id>/wiki/`): `index.md` catalog, `log.md` timeline, and
   overview/architecture pages that track the build as it lands.
4. **Let it compound.** Send follow-ups that extend the app; watch the wiki gain
   pages, updated cross-references, and new `log.md` entries while the code
   stays the source of truth.
5. **Delegation (optional, brief).** Note that wiki maintenance is delegated to
   the `@wikier` subagent so the main thread stays focused on coding.

## Demo beats checklist

- [ ] Success path visible first
- [ ] Real container kill → error span with genuine exit code
- [ ] Diagnosis and recovery nested under the failing span
- [ ] `RECOVERY_VERIFIED` on the follow-up turn
- [ ] Errors-only filter keeps tree hierarchy
- [ ] JSON export is secret-free
- [ ] Follow-up message resumes the same session
- [ ] Large task scaffolds `wiki/` (index + log + overview/architecture)
- [ ] Wiki tracks the build across follow-up messages
- [ ] `wikier` subagent pre-seeded at `.codex/agents/wikier.toml`

## Related

- [AgentGuard PRD](docs/AgentGuard%20PRD.md) §15 — canonical scenario
- [README](README.md) — platform overview

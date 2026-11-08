# Chat-test run template

Copy this into `README.md` (append, never overwrite) for every run.
Full loop: `AGENTS.md` (this folder) → Routine. Project protocol: `../AGENTS.md`
→ Chat Testing Protocol.

## Run N — <short topic> (<date>)

Task attempted (as a first-time consumer, tools only):
-

### Friction (raw confusion first, one item each, tagged)

- `request:` —
- `response:` —
- `tool:` —

### Simplification (what should change so the next LLM doesn't trip)

-

### Plan

`plans/<NN>_<topic>.md` — one section per finding, each with unit + live MCP tests.

### Fix + verify

- Code diffs (scope-locked):
- Unit: new tests + full suite (zero new failures vs baseline):
- Live (rebuilt/restarted container, MCP tools only):
- Close-out: findings fixed with revision numbers:

# Agents — `friction/`

Protocol for this folder. The project-level protocol is `../AGENTS.md` →
[Chat Testing Protocol](../AGENTS.md#chat-testing-protocol); this file is the
folder-local version and wins on any detail it covers.

## What this folder is

The friction log. It records what an LLM consumer *actually* faced while driving
the navigator MCP tools blind — no source, no shell, no curl — so the tool
surface gets simpler for the next first-time consumer.

`README.md` is the append-only run log. `RUN-TEMPLATE.md` is the shape of a new
run. **Never overwrite `README.md`; append a new run below the last one.**

## The blind rule (why the log is trustworthy)

1. Drive **everything** through the harness tools only — `web_search`,
   `web_fetch`, `web_page_links`, `web_page_screenshot`, `web_page_ascii`,
   `web_page_svg`, `web_fetch_setup`, and the devtools tools. Never read source
   to answer the task, never `curl` an endpoint, never run a repo harness script
   to do the task itself.
2. Act as a first-time consumer. The only knowledge you carry is the Tool
   Contract in `../AGENTS.md` — no internals, no assumptions.
3. Run a real end-to-end task (search → pick refs → fetch → synthesize → visual
   check), phrased the way a user would phrase it, and face the problems yourself
   instead of reasoning around them.

## Tagging (one tag per finding, no exceptions)

| Tag | Layer | Meaning |
|---|---|---|
| `request:` | the schema/docs | the tool description or param names misled you or forced an awkward choice |
| `response:` | the output | the reply was hard to consume — ambiguous refs, silent truncation, noise, confusing errors |
| `tool:` | the tool | the tool needs a capability or behaviour change — new param, better error, different default |

Docs disagreeing with observed behaviour **is** a finding (docs drift). Raw
confusion first, simplification second. Do not fix anything silently and do not
absorb friction — every `request`/`response`/`tool` complaint from a blind run is
a filed bug report or feature request.

## Routine (every run, no skipping)

1. **Run** the task in blind mode and finish the task itself.
2. **Log** the friction here in `README.md` — task, `request`/`response`/`tool`
   findings, simplification, plan pointer. Keep the `## Run index` at the top
   current.
3. **Plan** the fixes in `plans/<NN>_<topic>.md` — one section per finding, each
   with its own testing section (unit + live MCP checks). Testing is mandatory.
4. **Fix** the code (STRICT mode: scope-locked, minimal diffs), unit test per fix;
   the full suite must show zero new failures vs the documented baseline.
5. **Verify live** through the MCP tools only (rebuild/restart the container
   first so the server runs the new code), then close the finding out as fixed
   with revision numbers — a `## Fix close-out (plan NN, …)` section in
   `README.md`.

Build/test commands, the container-restart rule and the console-rebuild rule all
live in `../AGENTS.md` — read them there, never from memory.

## What does not belong here

- Source-reading walkthroughs, architecture notes, or plans → `plans/`.
- Durable product knowledge (how an extractor works, a config variable's
  meaning) → `../AGENTS.md` Project Learnings or `docs/`. A friction finding is
  an *experience*; what it taught goes somewhere else once fixed.
- Anything learned by reading the source instead of using the tools — that is
  not a blind run, it is a code review.

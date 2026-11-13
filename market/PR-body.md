# Add Orliba/dsh-ratchet

- [x] I added **one file** at `data/plugins/Orliba__dsh-ratchet.yml` — that single file is the whole submission.
- [x] My repo's `package.json` declares **`dsh.bundle`** (`dsh.bundle.patch: ./cordis.patch.yml`, plus `dsh.client` for the browser half).
- [x] My repo is at least **1 day old** — created 2026-11-10.
- [x] `category: workflow` — it is a delivery-rhythm controller: align before work, checkpoint every stage.
- [x] Description states what the plugin does, no superlatives.
- [x] My repo has the `dsh-plugin` topic.
- [x] Published as `dsh-ratchet@0.2.0` on npm, and the package's `repository` field points back at this repo. No `npm:` key in the entry.

## What it does, checked against the code rather than the README

- **`ratchet_start`** — scans the working directory (`CONTEXT.md`, `CONTEXT-MAP.md`, `README.md`, `package.json`, `pyproject.toml`, `AGENTS.md`, `CLAUDE.md`, whether `docs/adr/` exists), puts the remaining alignment questions into the question panel, and **drops the toolchain question when a manifest is already present** (`plugin/index.mjs:292`, `if (reconInfo.hasManifest !== true)`). At most 5 questions per round (`maxQuestions`, 1–5), each with a recommended option first.
- **`ratchet_checkpoint`** — end of every stage. It `stat`s each claimed artifact and reports the line count it read, marking a missing file as missing instead of trusting the model's summary; then runs three vendored linters (from MIT `mattpocock/grill-with-docs`, three documented local patches) over `CONTEXT.md`, `docs/adr/` numbering, and glossary-to-code consistency; then presents the next step as options — continue, change direction, or stop.
- **`/ratchet [off|topic]`** — opens or closes the flow.
- **Progress** is a session projection (`plugin:dsh-ratchet/state`, key `ratchet`), so it survives resume and fork; nothing is written into the user's workspace.
- **Settings page** (keyed slot `plugins.bundle.config`, through the host's `configForms`): enable switch, question cap, validator timeout, python path, stage cap, discipline text. All six fields are `volatile()`, so a save takes effect without a restart; turning the switch off makes both tools refuse and removes the prompt section immediately.
- **Tool rows** are replaced through `tool.call.toolview` (keys `ratchet_start` / `ratchet_checkpoint`) and read structured data from `output.presentationMeta`, so the card shows the stage, the verdict chips and the file chips instead of raw JSON.

129 offline tests (`node --test`), no build step.

## Honest limits (also in the README)

- The three linters are Python and the plugin shells out to them. It probes `python` / `python3` / `py -3` / the bundled runtime and reports the check as skipped with the reason rather than failing the checkpoint. `pythonPath` overrides the probe.
- Three local patches to the vendored linters, each documented in the README: `.mjs`/`.cjs` added to the scanned extensions (otherwise a DSH plugin scans zero files), singular glossary terms also match plural code identifiers, and an `--exclude` flag so vendored sample data is not reported as undefined domain terms. Upstream behaviour is unchanged when those flags are not used.
- On-screen copy (panel body, option labels, skip reasons, discipline text) is Chinese; comments and the README are English. There is no `locale` layer yet, so an English-only user sees Chinese panel copy.
- The checkpoint panel is a normal question panel with a long `detail`; it deliberately does not use the `plan-review` intent, so it never collides with plan mode's approval state.

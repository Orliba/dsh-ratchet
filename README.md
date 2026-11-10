# dsh-ratchet

A ratchet for [DeepSeek Harness](https://github.com/deepseek-ai) agents: align the
direction in a question panel **before** any work starts, deliver in counted
stages, and force a review checkpoint — with the artifacts verified against disk —
before the next stage can begin.

The problem is not that a model will not ask questions. The problem is that it does
not **stop** to ask: one "I understand" and three hundred lines later the direction
turns out to be wrong. A prompt can ask it to stop; a prompt cannot make it. So the
stop has to be code.

---

## Compatibility

- **DeepSeek Harness `>= 0.2.0-rc.1`** — declared under `dsh.engines.dsh`.
- **Node.js `>= 22`** — no build step, no bundler.
- **Verified on:** DSH Desktop **44.7.0** (Windows) — tool rows render as custom
  cards, the question panel takes the injected stylesheet, and the config page
  appears under *Settings → Plugins → dsh-ratchet → Config*.

It uses public APIs only: `systemPrompt.section`, `commands.register`,
`tools.register`, `userQuestions.ask`, `sessionProjections.register`, and the
`tool.call.toolview` / `plugins.bundle.config` seats. If a future build changes
their shape, the host half warns and registers nothing instead of taking the host
down, and the client half falls back to a one-line card.

---

## Why "ratchet"

A ratchet turns one way only. Each tooth is caught by a pawl and **cannot come
back**. That is the shape of this flow:

- **One way.** Align once up front; never redo the direction later. Aligning costs
  a minute, rework costs a day.
- **Tooth by tooth.** One tooth is one stage. It clicks, and the click is a
  checkpoint.
- **Caught.** Without your confirmation the next tooth will not turn. Not because
  the model "remembers" to ask — because the mechanism cannot advance if it does
  not.

Every part of the name has a mechanical counterpart. It is not a stretched
metaphor.

---

## What it forces

| | what a skill does | what this plugin does |
|---|---|---|
| **Ask the direction** | asks in chat, one line at a time | opens a question panel (`ctx.userQuestions.ask`); the questions have to appear in the UI, they cannot leak into chat |
| **Split the work** | the model paces itself | explicit stages, numbered, written into the prompt — "current position: stage N" |
| **Get it accepted** | the model remembers to ask | `ratchet_checkpoint`: no confirmation, no next stage — and the artifact list on that panel was **verified by reading the disk** |

The third row is the point. The model says "I changed three files"; the plugin runs
`statSync` on those three paths, and anything missing is marked **missing** instead
of taken on trust. The same panel also carries three document checks — the
`CONTEXT.md` glossary, the `docs/adr` numbering, and glossary↔code consistency.
In the skill those Python validators were run whenever the model felt like it. Here
they run on every checkpoint.

---

## Install

Add it to the profile's `package.json`. From npm, pin a version; for local
development, use `link:`:

```json
{
  "dependencies": {
    "dsh-ratchet": "^0.2.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-ratchet"]
    }
  }
}
```

For local work replace the dependency with
`"dsh-ratchet": "link:/absolute/path/to/dsh-ratchet"`.

Then run `pnpm install` in the profile directory — with `link:` it creates a
junction, from npm it unpacks normally — and restart DSH.

The tool schemas are hand-written raw JSON Schema, so there is no `zod` and no
`dsh-tools` dependency. The one package dependency is
`@deepseek-ai/schemastery`, declared under **`peerDependencies`** and resolved from
the host's own copy, because the config page needs a `Config` schema that the
host's `describe()` will recognise. `peerDependencies` is not a preference here:
the host only allows `@deepseek-ai/*` specifiers through for a linked plugin when
the name appears in its `peerDependencies`.

### Configuration

Nothing to hand-edit. After install, open
**Settings → Plugins → dsh-ratchet → Config**; all six values are editable there and
saving takes effect immediately, without a restart. `cordis.patch.yml` is only the
starting point.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers nothing; turning it off while running disables `/ratchet`, both tools and the prompt section at once |
| `maxQuestions` | `5` | Questions per round (1–5) |
| `validatorTimeoutMs` | `20000` | Timeout for one validation script (min 1000) |
| `pythonPath` | `''` | Explicit interpreter; empty probes `python` / `python3` / `py -3` / the runtime bundled with DSH |
| `stageLimit` | `5` | Suggested stage count for one flow, written into the prompt (1–12) |
| `policyText` | `''` | Replace the built-in discipline text; empty keeps the six shipped lines |

Live updates come from `liveConfig()` in `plugin/config.mjs`: every field is a
getter that reads the cordis volatile reference at access time, so no re-`apply()`
and no restart is needed.

---

## Use

### 1. Open a flow

```
/ratchet turn a folder of paper PDFs into markdown
```

`/ratchet off` exits. With no topic it opens the flow **without inventing a
title** — it says plainly that nothing is decided yet and asks you for one line,
rather than parking a placeholder like "unnamed task" in the prompt as if the
direction were known.

### 2. Let it ask

The model calls `ratchet_start`:

```json
{ "topic": "PDF folder to markdown", "mode": "kickoff", "brief": "I assume you want it local and offline" }
```

The plugin scans the directory first (`CONTEXT.md`, `CONTEXT-MAP.md`, `README.md`,
`package.json`, `pyproject.toml`, `AGENTS.md`, `CLAUDE.md`, `docs/adr`) and drops
every question the files already answer: a `package.json` means no stack question,
a `CONTEXT.md` means no terminology question. What it actually read is listed at
the top of the panel, so you can see whether it looked or just guessed.

Four to five questions by default: direction, acceptance, boundary, rhythm — plus a
stack question only when no manifest exists. The first option of each carries
**(recommended)**, so pressing Enter is a valid answer.

### 3. Close a stage

```json
{
  "stage": "get PDF extraction working",
  "summary": "pypdf pulls text fine on single-column papers; two-column order is still scrambled, next stage.",
  "artifacts": ["src/extract.py", "test/test_extract.py"],
  "next": "handle two-column layout",
  "decisions": ["no OCR — scanned PDFs are out of scope for this version"]
}
```

The panel body is rendered markdown, not raw text. Section labels and skip reasons
are on-screen copy and follow the user's language (they are Chinese in the sample
below this plugin ships for its author); they are shown in English here for
readability:

```
> **Stage 1 · get PDF extraction working**

pypdf pulls text fine on single-column papers; two-column order is still
scrambled, next stage.

---

#### Artifacts

- `src/extract.py` · 96 lines
- `test/test_extract.py` · 31 lines

---

#### Decided

- no OCR — scanned PDFs are out of scope for this version

---

#### Document checks

glossary !　ADR –　consistency –

- no-avoid: term "Session" is missing its `_Avoid_` line

---

> Previous stage was "align the direction".

---

> **Next**　handle two-column layout
```

Three validators collapse into one row of marks (`✓` pass / `!` problem / `×` fail /
`–` skipped); only the failing items expand, at most three, the rest become "N
more". The whole body sits in a bordered block with its own background instead of
being poured straight onto the card.

**When all three skip, it does not print a row of dashes.** Three skips mean the
directory has no `CONTEXT.md` and no `docs/adr/` yet — the validators have nothing
to read — but `– – –` reads like broken machinery, a fault report rather than a
status. So that case becomes one honest sentence plus the reasons:

```
#### Document checks

3 validators did not run — this directory has nothing for them to check yet:

- no CONTEXT.md (no glossary in this stage)
- no docs/adr/ (no decision record needed here)
```

Identical reasons collapse to one line, and prefix duplicates are absorbed ("no
CONTEXT.md" and "no CONTEXT.md (no glossary in this stage)" are said once). The tool
row says the same thing in one line — `– checks did not run — no CONTEXT.md` — with
the full reason in the `title`. A real failure also gets plain words:
`python won't start (interpreter not found)`, `timed out`, `interrupted` — never
`spawn ... ENOENT` in the user's face.

The paths in the artifact list are not copied from what the model said; the plugin
looks for them. Relative paths resolve in three steps: absolute as-is → directly
under the working directory → **one level of subdirectories** (skipping
`node_modules` and dot-directories, at most 16). The third step exists for one
specific trap: when the model says "I changed `plugin/render.mjs`", the root in its
head is often the project subdirectory while the working directory sits one level
above, so naive joining produces a path that does not exist and marks a real file
as missing — which reads to the user as "it is lying to me". When a file really is
absent, the message includes the absolute path that was searched
(`**missing** (looked for \`/work/plugin/render.mjs\`)`), and a subdirectory hit
says which level it was found at (`· 171 lines · under \`dsh-ratchet/\``).

Options: `continue (recommended)` with the next stage in its description, up to two
alternatives you passed in, `change direction` (type the new one), `stop here`.
Choosing "change direction" writes the new direction into the projection and the
next stage follows it; "stop here" closes the flow and the prompt section stops
being injected.

---

## UI

The plugin ships a browser half (`plugin/client.js`) that does three things.

**Tool rows.** `ratchet_start` / `ratchet_checkpoint` no longer render as a blob of
raw arguments. They render as their own card: a status dot (blue running, green
pass, amber problem, grey skipped), the stage title, the check marks, the artifact
list with missing files flagged, and a collapsible "next". The data comes from the
tool's `output.presentationMeta`, structured JSON projected onto `block.meta` —
never from the model retelling its own work.

**Panel body.** The panel card belongs to the host and its structure cannot be
changed, but an injected stylesheet gives the body its own layer: background,
radius, padding, and the host's markdown defaults tightened (headings from `32px`
down to panel scale). The selector is
`[data-question-scroll] > div:first-child:not([role])`, which hits the body and
leaves the option list alone.

**Config page.** Mounted at *Settings → Plugins → dsh-ratchet → Config* through the
keyed seat `plugins.bundle.config` (key = package name), on the host's
`configForms`. The five scalars go through `SettingsFormModel` for drafting and
conflict retry; `enabled` has no primitive, so it keeps its own draft and the save
path **writes the form first, then writes the switch with the revision the form just
produced**.

Those must be two writes, never one: `SettingsFormModel.save()` already advances the
revision with its own baseline, so appending the switch op to that batch means
writing with a stale revision — guaranteed `SETTINGS_CONFLICT`. The test pins the
order with "the second write must carry `revision === 2`".

A failed form does not silently write the switch either: it stays where you put it
and says "the switch was not saved, try again", rather than pretending. Turning it
off disables `/ratchet`, both tools and the prompt section immediately.

CSS uses `--dsw-alias-*` theme tokens only, with no hard-coded colours, so both
themes follow. If a host update changes the class structure the card degrades to a
single line rather than throwing, and if the config primitives do not match the
page is simply not mounted — the tool rows keep working.

---

## Honest limits

- **No automatic entry.** It never guesses whether a message starts a new task.
  Sniffing "is this a new task" misfires on small talk and harmless questions, and
  one misfire means a panel before every conversation. The price is remembering one
  command; what it buys is a plugin that can never appear when it should not.
- **No `plan-review` intent.** That intent conflicts with plan-mode's approval
  state, which requires `approve` to match an option label. Plain questions carrying
  the body in `detail` avoid the collision.
- **Sub-agents cannot open the panel.** `userQuestions` accepts root agents only;
  a delegated caller throws `DELEGATED_CALLER`. That is caught and degraded to the
  same content as a chat message, so a sub-agent can relay it and you can answer —
  rather than a tool call failing outright.
- **The panel styling is a guest.** It depends on host DOM hooks
  (`data-question-scroll`) and the theme tokens above. A host rewrite can take the
  visual layer away; it cannot break the flow.

---

## Development

```sh
npm run check   # syntax check on six files
npm test        # node --test, 129 cases, in order
```

Tests come in layers. The first does not boot DSH: a fake `ctx` exercises the
registration paths and pins that the discipline section returns an empty string when
inactive (a resident section would burn tokens on every request), that
`mergeQuestions` dedupes and trims, that the projection folds four ops, and that the
validators **never throw** on a missing python, a missing file, a timeout or an
abort. The second checks the rendered body: `render.mjs` output structure — the
marks, the missing-file annotations, the collapse count, and the absence of raw HTML
and task lists, which the host's `MarkdownText` does not support. The third
(`test/integration.test.mjs`) runs against a real `Session`, a real cordis
`Context`, a real `SessionProjectionRegistry` and a real `appendPluginRecord`, and
verifies the three things only the real packages can: that the record type passes
the host's type regex, that the projection folds state back out of a real event log,
and that unrelated events do not swap the state reference (a swap would make the
host recompute the view for nothing). `test/client.test.mjs` builds a fake
`window`/`document` with `new Function` and runs the browser half: which two keys it
registers, whether the stylesheet is injected and cleaned up, and whether it
survives a missing `block.meta`.

Under bare Node, `@deepseek-ai/*` does not resolve — the profile's `node_modules`
has no such scope; resolution works only through the `ResolutionRouter` the host
installs at launch. `test/register.mjs` plus `test/host-resolver.mjs` are an ESM
resolution hook for tests only. Production code does not rely on it: when the import
fails, `writeState` falls back to an in-memory mirror, which is a designed
degradation path, not an accident.

`plugin/vendor/` holds the three stdlib-only Python validators copied from
`grill-with-docs` (MIT, upstream by Matt Pocock). The upstream directory is
read-only; change the vendored copy.

### Three local additions to the vendored validators

Copied as-is, the glossary↔code check either never speaks in a DSH project or
speaks only noise, so the vendored copy carries three changes, each marked
`[ratchet local addition]` in code:

1. **`.mjs` / `.cjs` added to `DEFAULT_EXTENSIONS`.** Upstream knows
   `.py/.ts/.js/...` only, while DSH plugins are almost entirely `.mjs` — zero files
   scanned means "nothing to check" and the whole check is skipped, i.e. not
   installed at all.
2. **`count_term_in_text` accepts an optional plural suffix**
   (`\bTerm(?:s|es)?\b`). A glossary entry written as `Artifact` against code that
   says `artifacts` is normal; upstream called that a dead term. Measured: `Artifact`
   0 → 14.
3. **An `--exclude` flag, plus skipping all-caps words.** The flag keeps
   `plugin/vendor/` out of the scan — it holds upstream sample data
   (`Order`/`Customer`/`Product`) that would pose as undefined domain terms here. The
   all-caps skip is because `COPY`/`DEFAULTS`/`SKIP`/`ADR` were being reported as
   "terms that should be defined", and twenty-five lines of that drowns the real
   signal.

All three are additive; the defaults keep upstream behaviour. Each has a regression
test in `test/validators.test.mjs` so a future upstream sync cannot quietly undo it.

---

## Layout

```
package.json
cordis.patch.yml
CONTEXT.md                  the plugin's own glossary — it validates itself
docs/adr/0001-*.md          one decision record, on projections over state files
plugin/
  index.mjs                 prompt section + command + two tools
  config.mjs                six configurable fields + liveConfig hot reads
  render.mjs                panel body layout (MarkdownText-safe syntax only)
  client.js                 browser half: tool cards, panel CSS, config page
  state.mjs                 projection + plugin record read/write
  validators.mjs            wrappers around the three validators (never throw)
  vendor/*.py               CONTEXT.md / ADR / glossary↔code validators
test/
  index.test.mjs            section + command + assembly
  render.test.mjs           panel body layout
  client.test.mjs           browser half: card registration, styles, config page
  validators.test.mjs       degradation behaviour of the three validators
  tools.test.mjs            full execute() paths against a fake panel
  integration.test.mjs      real host: Session + cordis + projection registry
  register.mjs              test-only resolution hook registration
  host-resolver.mjs          maps @deepseek-ai/* to the host install directory
```

## License

MIT.

# Documentation Standard

This file is the standard for Synergy documentation: where each kind of fact lives, how documents are written, and what the gates enforce. The root [AGENTS.md](../AGENTS.md) carries standing orders; this file carries the placement rules those orders route to.

## One home per fact

Every fact has exactly one home. Everywhere else, link there; never restate. The tiers:

| Tier                                 | Job                                                                                                   | Enforced by                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| Root `AGENTS.md`                     | Standing orders, 1-3 lines each, linking the rationale home                                           | `doc:check` budgets         |
| Subtree `AGENTS.md`                  | Orders specific to that subtree only; never repeat repo-wide rules                                    | `doc:check` budgets         |
| `docs/architecture/`                 | Current implementation invariants, one page per owned domain                                          | review                      |
| `docs/decisions/`                    | Decision records: the why and what-was-given-up, path-encoded by lifecycle and class                  | `decision:check`            |
| `docs/postmortem/`                   | Incident stories — the only tier where war-story narrative belongs                                    | `docs/postmortem/README.md` |
| `docs/reference/`                    | Commands, config, paths, packages, development procedures; generated catalogs must not be hand-edited | `doc:check` freshness       |
| `docs/plugins/`                      | The public extension contract                                                                         | review                      |
| `docs/operations/`                   | Release, quality, and observability runbooks                                                          | review                      |
| `docs/product/`                      | User-facing objects and flows                                                                         | review                      |
| `docs/migrations/`, `docs/research/` | History and investigations only                                                                       | review                      |
| `.synergy/skill/`                    | Executable workflows: step-by-step procedures with verification checklists                            | `skill:check`               |
| Package `README.md` / `AGENTS.md`    | Per-package contract and boundary                                                                     | `doc:check` budgets         |

Placement rule: **bugs → postmortems; rationale → decision records; procedures → Skills; type definitions → architecture pages; package contracts → package READMEs; standing orders → root AGENTS.md with a rationale link.**

## Classifying a document

Classify every in-scope document as a tutorial or a reference. Tutorials follow an ordered path to an outcome; references define a lookup scope for a named subject. Do not mix them: a reference page that walks the reader through steps belongs in a Skill or a guide, and a tutorial that digresses into field-by-field semantics is pointing at the wrong home.

## Writing rules

- One physical line per paragraph. Fenced code blocks, tables, lists, and headings are exempt. `doc:check` (md-wrap) enforces this.
- Relative links only, and md links must resolve including `#fragment` anchors. `doc:check` (md-links) enforces this.
- Write current state directly. Delete obsolete explanations instead of layering caveats. When code and docs conflict, verify code and tests, update the canonical document, and remove stale wording elsewhere.
- No metaphors in technical prose. Before writing `contract`, `boundary`, or `shape`, ask whether a more exact term names the subject.
- Generated reference pages (`docs/reference/cli.md`, `configuration.md`, `tools.md`) must never be hand-edited; run `bun run doc:gen` instead. The `--check` freshness gate fails the build when they drift from source.

## Slop checklist

When reviewing docs, these patterns are defects:

- Narrated history ("previously / now / no longer") in current-state documents
- Status annotations on implemented things ("as of writing", "currently supports")
- Hand-restated catalogs that a generator already produces
- Reasoning transcripts; a decision's rationale belongs in a decision record, linked
- Repeated rationale across documents; link the home instead
- Paragraph walls; one physical line per paragraph
- Emphasis inflation (bold runs, all-caps sentences)
- Spec-speak in shipped records (proposal-era headings in implemented decisions)

## Word budgets

Instruction files are budgeted so "keep it short" is mechanical:

- Root `AGENTS.md` ≤ 1600 words
- `docs/AGENTS.md` ≤ 1600 words
- `packages/synergy/AGENTS.md`, `packages/app/AGENTS.md` ≤ 1100 words each
- All other subtree `AGENTS.md` ≤ 600 words each
- `docs/decisions/README.md` ≤ 1200 words; `docs/postmortem/README.md` ≤ 800 words

Budgets live in `script/doc-budgets.json` and `doc:check` (doc-budgets) enforces them. When a document exceeds its budget: relocate the content to its owning tier, condense it, or raise the ceiling in the manifest — in that order. A ceiling raise is a visible, reviewable change, not a default.

## Generated catalogs

`script/gen/gen-cli-reference.ts`, `gen-config-reference.ts`, and `gen-tool-catalog.ts` generate the CLI, configuration, and tools reference pages from source registries. Run `bun run doc:gen` after changing a command, option, config field, or tool definition; `doc:check` fails when the committed pages are stale. Hand-written conceptual prose for those areas lives in `docs/reference/cli-guide.md` and `configuration-layout.md`, never inside the generated files.

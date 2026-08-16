# Decision Records

One kind of design doc lives here. A **decision record** captures a non-trivial decision or proposal that affects this repository — the _why_ and _what it gave up_, the parts code and docs cannot carry. This file is the authoritative spec: where records live, when to write one, and the in-file format the `decision:check` gate enforces.

## Layout and naming

Every decision record has two axes, both encoded in its **path** — `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- **Lifecycle** (the top-level folder) is the record's status, and a record moves between folders as that status changes:
  - **`proposed/`** — a proposal under review before implementation; not yet built (or only partly).
  - **`implemented/`** — the decision shipped. The file records what was decided and what was rejected, and is kept current with what actually shipped (facts only — paths, names, structure — never the decision itself).
  - **`rejected/`** — the proposal was considered and declined. Keep it only while its rationale prevents a tempting, meaningful mistake; otherwise delete it.
  - **`archived/`** — a frozen implemented record whose rationale no longer guides current work. See [Archiving](#archiving).
- **Class** (the nested folder) is the _kind_ of decision, from the closed set below. The classification gate rejects other folders.

| Class            | What it covers                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `feature`        | A new user- or model-facing capability.                                                                        |
| `bug-fix`        | Corrects a defect or closes a gap a postmortem surfaced.                                                       |
| `simplification` | Removes code, behavior, or surface area without adding a capability.                                           |
| `architecture`   | A structural decision about the shipped source — how packages relate, what the runtime vocabulary is.          |
| `process`        | Tooling, policy, or workflow _around_ the code — gates, the package manager, vendoring — not runtime behavior. |
| `testing`        | Test infrastructure and strategy.                                                                              |

The `architecture` / `process` line: **architecture** is about the source we ship; **process** is the surrounding tooling and workflow.

The date in the filename is when the topic was **first proposed** (per git history). Cross-references between records use relative markdown links (`[topic](../../implemented/architecture/2026-08-14-example.md)`) — never bare prose or numbers — so they are mechanically checkable and survive moves between folders.

There is deliberately **no central `INDEX.md`**: relative links are the index, and a generated index would drift, churn every move, and tempt readers to treat it as the canonical inventory. Browse the lifecycle/class folders or search the repository.

## The file format

Every record follows one in-file format, enforced by the `decision:check` gate. The first three lines are exactly:

```markdown
# Decision Record: <title>

Status: <status>
```

followed by a blank line. The `Status:` value is one of three forms, and must equal the lifecycle folder the file sits in — the gate cross-checks them:

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <one-line reason>`

The status carries no dates: the filename holds the first-proposed date and git holds everything else. The rejection reason is the one status with content, because a rejected record's verdict is the fact readers come for.

### Body skeletons

Every record opens its body with `## Problem` — the motivation, written to stand without the solution. What follows depends on the lifecycle:

- **`proposed/`**: `## Problem` / `## Proposal` / `## Alternatives considered` / `## Acceptance criteria` / `## Risks`. `## Proposal` may legitimately speak in the future tense. `## Acceptance criteria` says what observable state means done. `## Risks` covers both what could go wrong and what the change knowingly gives up.
- **`implemented/`**: `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`. `## Decision` describes shipped reality in the present tense. `## Consequences` records what the trade-off cost **and** bought. Proposal-era headings are spec-speak here and the gate rejects them: `## Proposal` and `## Acceptance criteria` may not appear in an implemented record.
- **`rejected/`**: the proposal, frozen — the same skeleton as `proposed/`, with the verdict carried on the `Status:` line (e.g. `Status: rejected — <one-line reason>`).

### Alternatives considered — mandatory

Every record carries an `## Alternatives considered` section: each genuine alternative and why it lost, one bold-led paragraph per alternative. A decision recorded without what it beat invites re-litigation — the failure decision records exist to prevent. Alternatives are recorded, never invented.

## When to write one

Every non-trivial change MUST add or update at least one implemented decision record in the same PR. A change is non-trivial when it alters behavior, architecture, a contract shared across files or packages, process or tooling, testing strategy, an on-disk, wire, or configuration format, or another decision a maintainer may reasonably revisit. A proposal for substantial future work starts in `proposed/`; a decision already made starts in `implemented/`. Pick the class folder that matches the decision.

Updating the record that already owns the decision satisfies the rule; do not create a duplicate. Only a purely mechanical or local edit with no change to behavior, contracts, structure, process, or rationale is exempt.

Implemented records stay current with what actually shipped: when code later moves a file, renames a package, or changes a key or default, the owning record is updated in the same change to match. The facts are updated; the decision is never rewritten — an implemented record is never edited into a _different_ decision. Supersede it with a new one and keep both cross-linked.

A supersession check is due whenever a record's topic area changes again. If the old record is superseded, archive it in the same PR that supersedes it (see below) rather than silently editing or deleting it.

## Archiving

Archive an implemented record when its decision is complete and its rationale is unlikely to guide future work. Keep it active while its alternatives, ownership boundary, negative guarantee, durable or wire semantics, security rule, or reintroduction condition remains useful. Never archive a proposed record — reject an obsolete proposal instead.

The archive is path-encoded as `archived/{class}/yyyy-mm-dd-topic-title.md`; `implemented` is deliberately absent because only implemented records can enter it. An archival change moves the file, retains `Status: implemented`, and inserts an `Archived: YYYY-MM-DD` line immediately below that status. These are the only permitted content changes during archival.

Once sealed, every archived record is permanently frozen. Do not edit, reformat, update, move, or delete it, and do not treat it as authority for current behavior. `archived/manifest.json` holds a sha256 hash per archived file and seals the content; the archive gate rejects any mismatch. The seal starts empty and grows only when a record is archived.

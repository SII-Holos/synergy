# Decision Record: Read denies survive every workspace shape under the deny-list read model

Status: implemented

## Problem

Under the deny-list read model, file reads are allowed globally and only the paths in `READ_DENY_PATHS` stay unreadable. Two defects in that mechanism left credential stores readable whenever the workspace overlapped them.

First, the profile builder pruned the deny list. `buildPermissionProfile` built a scope from the workspace **and every writable root** and dropped every deny equal to or inside it, on the reasoning that a writable root re-exposed those entries anyway. Measured on the shipped code, an ordinary workspace produced 28 read denies (single deny home) while a Scope directory resolving to `$HOME`, or `$HOME` reaching the profile as a writable root, produced the same list with **`~/.ssh` removed** — and `~/.ssh`, `~/.aws`, `~/.netrc`, and `~/.synergy/data/auth` all became readable. A real `sandbox-exec` child then read `~/.ssh/id_rsa` (2610 bytes served, where the fixed build serves 0). Reachability is production, not theoretical: additional project folders arrive as writable roots, and a Scope directory at the user home is a legitimate configuration.

Second, the pruning rationale rested on a false premise. The code and the record that introduced it both asserted that a subpath deny "wins under Seatbelt's most-specific-match resolution regardless of rule order". Seatbelt does not rank an overlapping allow and deny by specificity — it applies the **last matching rule**. Measured with two profiles differing only in rule placement: `allow`-then-`deny` blocked the read, `deny`-then-`allow` served it. The compiler emitted its read denies _before_ the parameterized writable-root allow, so a deny inside a writable root was already ineffective, and pruning removed the entry instead of fixing the order that made it useless.

Provenance: the pruning arrived with the macOS deny-list flip, not with the Linux read-model change that surfaced it. Both records are corrected by this one.

## Decision

The deny set is no longer a function of the writable roots, and each kept deny is emitted on whichever side of the writable-root allow makes it effective. `partitionDeniesByWritableRoot` in `packages/harness/src/sandbox/policy.ts` is the single owner of that split:

- a deny **containing** a writable root is emitted **before** the allow, so the deeper allow wins and a workspace nested inside a credential directory keeps working while its credential siblings stay denied;
- a deny **equal to or inside** a writable root is emitted **after** the allow, so the deny wins; a deny equal to a writable root fails closed this way.

`buildPermissionProfile` now drops exactly one entry: a deny **equal to the workspace**. A Scope directory rooted at a credential path cannot deny itself without making the project's own files unreadable. A deny strictly inside the workspace or inside any other writable root is kept, because an explicitly denied location is operator intent rather than a collision, and the ordering rule makes it effective.

`MacOSPolicy.compileProfile` consults the partition and emits the two groups around the writable-root allow. Containment is decided in the canonical spelling the rules are emitted in, because the writable roots bind through `canonicalize` and a raw-spelling comparison could place a deny on the wrong side and silently re-expose the credential.

The Linux half of the same ordering mechanism belongs to the read-model convergence work and is not part of this decision; on this revision the Linux backend consumes neither `readDenyPaths` nor the partition.

## Alternatives considered

**Keep pruning denies inside a writable root and justify it by the mount order.** Rejected: this is the shipped defect. Pruning is defensible only if the entry would be shadowed, and the emission order is what shadowed it. Dropping the entry discarded operator intent and disabled the deny for exactly the workspace shapes where credentials and project files most often coincide.

**Refuse a home-shaped workspace instead of keeping its denies.** Rejected: a Scope directory at the user home is a configuration operators use, and failing it would break the product to avoid a bug that ordering fixes outright. Fail-closed belongs on the deny's effect — an entry equal to a writable root is emitted last and therefore wins — not on the configuration.

**Order the emitted rules by path depth rather than by containment.** Considered and equivalent in effect for the cases that occur, since both express "the deepest path wins". The containment partition was chosen because it names the two required cases directly and reads as the same rule a bind-based backend would follow, instead of leaving the intent implicit in a sort.

**Rely on Seatbelt specificity and only fix the pruning.** Rejected: the specificity model was measured to be false, so keeping the denies without reordering them would have produced profiles that still serve credentials — a green build over an unchanged exposure.

**Deny only credential paths outside every writable root.** Rejected: it reduces to the shipped defect for a home-shaped workspace, where every credential path is inside the writable root. The interesting cases are precisely the ones this alternative cannot express.

## Consequences

`~/.ssh`, `~/.aws`, `~/.netrc`, and the runtime auth store are denied in all four measured configurations — ordinary workspace, workspace equal to `$HOME`, `$HOME` as a writable root, and workspace equal to the Synergy runtime home — and a real `sandbox-exec` child serves 0 bytes from `~/.ssh/id_rsa` where the shipped build served the full file. The deny count is a function of the deny homes (`readDenyHomeDirs()` returns the OS home plus the runtime home when it differs), so a count quoted without naming the home is meaningless; tests assert membership per path rather than a raw total.

The cost is a longer, load-bearing ordering contract: a backend that emits read denies must place each one on the containment-correct side of its writable allow, and getting the side wrong is silently insecure rather than visibly broken. `partitionDeniesByWritableRoot` exists so that contract has one owner and can be asserted rather than remembered.

The macOS compiler changes shape: read denies are now split around the writable-root allow instead of emitted in one block. The ancestor carve-out still works because the ancestor deny moves ahead of the allow, and the inside-writable-root case is newly enforced rather than newly documented.

Correcting the record's earlier claim is part of this decision: two documents described the removed behavior as current, and both are updated. The macOS half is verified locally against real `sandbox-exec`; the Linux mount half cannot execute on a macOS host and is not claimed here.

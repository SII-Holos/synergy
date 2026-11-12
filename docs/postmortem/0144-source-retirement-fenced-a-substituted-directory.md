# Source retirement fenced a substituted directory

## Incident

A real filesystem substitution test replaced the native Home directory just before the retirement marker was published. The operation rejected its final physical check, but the replacement directory already contained the irreversible format-four marker.

## Root cause

The source identity checks and the absolute-path atomic rename were separate effects. A pathname could resolve to another directory after validation. A final refusal did not undo a write into that replacement.

## Resolution

Retirement opens the existing regular, single-link ownership file without following links, matches its descriptor identity against the original directory and bounded file inspection, and writes through that retained descriptor. Truncation and each completed marker are synchronized. An interrupted write leaves an empty file or an exact prefix of the deterministic selected marker. Ordinary readers reject that state. The retirement-only inspection recognizes that prefix without granting startup or performing repairs; the Domain must validate its original permanent reservation and native authority before retrying the same marker.

## Verification

The original test produced a real failure: the replacement directory contained format four after the operation rejected. The corrected Harness tests swap the directory or ownership file during the actual descriptor write, then confirm that the replacement retains its original format-two owner and that only the detached original inode receives the marker. Additional tests interrupt an actual write, retry only the same marker, reject arbitrary malformed bytes, and retain lost synchronization acknowledgements. Literal released-reader credential and SQL controls remain covered.

## Guardrails

Bind irreversible native publication to the actual opened file identity. An after-effect pathname check cannot authorize or undo that effect. See [descriptor-bound retirement](../decisions/implemented/bug-fix/2026-11-12-bind-source-retirement-to-its-opened-file.md).

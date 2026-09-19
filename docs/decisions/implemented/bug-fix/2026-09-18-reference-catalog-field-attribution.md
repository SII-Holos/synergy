# Decision Record: Reference catalogs read a field's own schema chain

Status: implemented

## Problem

The generated reference catalogs attributed the wrong JSON Schema facts to large configuration fields, and the error was self-concealing: the generator read its source with a line-bounded scan and then picked the last `.describe()` it could find in whatever it had collected.

Three independent defects combined in `script/gen/shared.ts`:

1. `parseObjectFields` only walked a continuation chain while it stayed under 30 lines. The `execution` field in `packages/harness/src/config/schema.ts` has about 205 lines of body, so its scan stopped roughly a sixth of the way in and never reached the field's own trailing `.describe("Process isolation, worker recycling, and bounded execution scheduling")`.
2. `inlineDescribe` used `expr.lastIndexOf(".describe(")`. On a truncated object body, the last `.describe()` belongs to the deepest nested leaf that happened to fit, so the `execution` row in `docs/reference/configuration.md` published "Time an excess idle Agent worker remains warm before retirement (default: 60000)" — a child property's text — as the description of the parent object.
3. `zodTypeOf` probed for constructors anywhere in the expression rather than at its head, so an object containing an enum could be reported as that enum. Before the truncation was fixed this was masked; completing the expression exposed it, and `execution` began rendering as `"local_process" | "file" | ... | "control_plane"` instead of `object`.

The same path produced a set of related misattributions in both generated pages. `provider`, `instructions`, `tools`, `mcp`, `role_variant`, `pluginConfig`, `external_agent`, `enterprise`, and `category` all render incorrectly for the same two reasons, and the tool catalog inherited them for array-typed parameters (`tags`, `sessionRefs`, `states`, `paths`, `globs`, `completed`, `evidence`, `remaining`, `acceptance`, `refs`) plus `onGithub` and the `attach` path parameters.

Nothing failed while this was wrong. The generator is freshness-gated, so a stale page is caught, but a self-consistently wrong page is not: the check compares generated output against the generator's own output, not against the schema. That is why the defect survived until a Blueprint review looked up a specific row and found a nested field's text describing its parent.

## Decision

The reference generators read a field's own schema chain and nothing else.

- `parseObjectFields` ends a continuation by indentation rather than by a line count: a line whose indentation stops the chain and that does not begin with `.` terminates the expression, and so does a balanced line that ends in a comma. A chained call on a deeper continuation never terminates it, and neither does an interior brace that closes a nested object, so a large object body reaches its own trailing modifiers.
- `inlineDescribe` resolves the describe that the field itself owns. `owningDescribe` walks the expression tracking nesting depth and string state, and records a `.describe(` only at depth zero, so a describe inside an object literal documents the nested property and never the parent.
- `zodTypeOf` anchors each probe to the head of the expression. A field's type is its outermost constructor: an object that contains a `z.enum` is an object, and a union of string and array is a union.

`test/script/gen-catalogs.test.ts` covers the three invariants directly, including a 40-property object that exceeds the old bound and a parent whose describe chains after a nested child's.

## Alternatives considered

**Raise the line cap instead of removing it.** Rejected: a larger constant moves the failure to the next field that grows past it, and the mode stays silent. The indent rule is a property of the source rather than a budget, so it does not decay.

**Patch the specific rows in `docs/reference/configuration.md` and `docs/reference/tools.md`.** Rejected: both files are generated, the repository forbids hand-editing them, and the underlying misattribution would be reapplied by the next regeneration.

**Keep `lastIndexOf` and trim the expression at the field's own comma.** Rejected: locating the owning describe by depth is the actual question. Trimming first would still need the same nesting walk to know which comma ends the field, and it would silently mis-handle a nested object whose last property is itself an object.

**Have the generator import the schemas and emit from parsed JSON Schema.** Rejected for this change: the generator is deliberately static source analysis so its output is deterministic and independent of runtime state, and switching it to import `Config.Info` would pull the whole harness runtime into a documentation script and make the catalogs depend on extension registration order.

**Assert the generated rows against the live schema in a test.** Rejected as the primary mechanism: it would duplicate the generator's own logic in the test and still pass when both agree on the same wrong answer. The targeted unit tests pin the parser invariants instead.

## Consequences

The two published reference pages now describe each configuration field with that field's own text and type. This changed roughly 128 lines across `docs/reference/configuration.md` and `docs/reference/tools.md`, all of which are corrections: `execution` recovers its own summary and `object` type, `provider` and `mcp` report `record` rather than `string`, `instructions` and the tool argument lists report `array`, `onGithub` reports `object`, and `formatter` reports `union`. Six rows lost a description — `prompt`, `enterprise`, `question`, `compaction`, `toolExposure`, and `boss` — because those text blocks actually belong to nested properties (`coauthorReminder`, `enterpriseUrl`, `question.timeout`, `compaction.codexRemote`, and so on), and the parent object genuinely has no description of its own. Those rows are now empty rather than misleading; describing the parents is a separate documentation task, not a generator defect.

The generator remains deterministic and its freshness gate is unchanged, so the corrected pages stay pinned to the parser behavior. The new invariants are pinned by unit tests rather than by the freshness check, which cannot distinguish a correct page from a consistently wrong one.

import { describe, expect, test } from "bun:test"
import { InstructionEngine } from "../../src/instruction/engine"

/**
 * H7 instruction engine golden matrix (S7a). Locks the unified placeholder
 * semantics shared by the skill and command instruction sources before the
 * S7b slice rewires both renderers onto the engine:
 * - `$N` one-based positional; the highest position consumes the remainder
 * - `$ARGUMENTS` raw trailing text (quotes preserved)
 * - `$ARGUMENTS[N]` zero-based indexed
 * - quoted arguments tokenize as one value; `[Image N]` tokens pass through
 * - out-of-range positions and indices render empty
 * - no-placeholder templates: append mode (skill) vs single-part (command)
 * - the engine never executes shell syntax — policy stays in the domain
 */
describe("InstructionEngine golden matrix", () => {
  test("one-based positions with the highest consuming the remainder", () => {
    expect(InstructionEngine.render({ template: "$1 | $2", arguments: "one two three" })).toEqual(["one | two three"])
  })

  test("$ARGUMENTS substitutes the raw argument text including quotes", () => {
    expect(InstructionEngine.render({ template: "Request: $ARGUMENTS", arguments: 'one "two three"' })).toEqual([
      'Request: one "two three"',
    ])
  })

  test("zero-based $ARGUMENTS[N] indexing", () => {
    expect(
      InstructionEngine.render({ template: "$ARGUMENTS[0] | $ARGUMENTS[1]", arguments: 'one "two three"' }),
    ).toEqual(["one | two three"])
  })

  test("quoted arguments tokenize as single values", () => {
    expect(
      InstructionEngine.render({
        template: "$1 | $2 | $3",
        arguments: `"double value" 'single value' plain`,
      }),
    ).toEqual(["double value | single value | plain"])
  })

  test("out-of-range positions and indices render empty", () => {
    expect(InstructionEngine.render({ template: "<$1><$4><$ARGUMENTS[4]>", arguments: "only" })).toEqual(["<only><><>"])
  })

  test("empty arguments substitute empty, not an error", () => {
    expect(InstructionEngine.render({ template: "Request: <$ARGUMENTS> <$1>", arguments: "" })).toEqual([
      "Request: <> <>",
    ])
  })

  test("append mode adds trailing text as a second part only when arguments exist", () => {
    expect(
      InstructionEngine.render(
        { template: "Follow this Skill.", arguments: "Do the requested work" },
        { appendArgsWhenNoPlaceholder: true },
      ),
    ).toEqual(["Follow this Skill.", "Do the requested work"])
    expect(
      InstructionEngine.render(
        { template: "Follow this Skill.", arguments: "" },
        { appendArgsWhenNoPlaceholder: true },
      ),
    ).toEqual(["Follow this Skill."])
  })

  test("default mode never appends, matching the command domain", () => {
    expect(InstructionEngine.render({ template: "Run this command.", arguments: "extra words" })).toEqual([
      "Run this command.",
    ])
  })

  test("no duplicate trailing text when a placeholder exists even in append mode", () => {
    expect(
      InstructionEngine.render({ template: "First: $1", arguments: "one two" }, { appendArgsWhenNoPlaceholder: true }),
    ).toEqual(["First: one two"])
  })

  test("shell syntax stays literal — the engine is pure text substitution", () => {
    expect(
      InstructionEngine.render({ template: "Never execute !`touch forbidden`; use $1.", arguments: "literal" }),
    ).toEqual(["Never execute !`touch forbidden`; use literal."])
  })

  test("tokenizeArguments exposes the shared tokenizer", () => {
    expect(InstructionEngine.tokenizeArguments(`"a b" c 'd e'`)).toEqual(["a b", "c", "d e"])
    expect(InstructionEngine.tokenizeArguments("")).toEqual([])
  })
})

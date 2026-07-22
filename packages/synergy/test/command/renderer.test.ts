import { describe, expect, test } from "bun:test"
import { CommandRenderer } from "../../src/command/renderer"
import { SkillRenderer } from "../../src/skill/renderer"

describe("SkillRenderer", () => {
  const cases = [
    {
      name: "replaces $ARGUMENTS with the raw trailing text",
      template: "Request: $ARGUMENTS",
      arguments: 'one "two three"',
      expected: ['Request: one "two three"'],
    },
    {
      name: "uses zero-based $ARGUMENTS[N] placeholders",
      template: "$ARGUMENTS[0] | $ARGUMENTS[1]",
      arguments: 'one "two three"',
      expected: ["one | two three"],
    },
    {
      name: "uses one-based $N placeholders and lets the highest position consume the remaining arguments",
      template: "$1 | $2",
      arguments: "one two three",
      expected: ["one | two three"],
    },
    {
      name: "treats single and double quoted arguments as one value",
      template: "$1 | $2 | $3",
      arguments: `"double value" 'single value' plain`,
      expected: ["double value | single value | plain"],
    },
    {
      name: "replaces out-of-range positions with empty strings",
      template: "<$1><$4><$ARGUMENTS[4]>",
      arguments: "only",
      expected: ["<only><><>"],
    },
    {
      name: "substitutes empty arguments without appending an empty request",
      template: "Request: <$ARGUMENTS> <$1>",
      arguments: "",
      expected: ["Request: <> <>"],
    },
    {
      name: "appends non-empty trailing text as an ordered request part when no placeholder exists",
      template: "Follow this Skill.",
      arguments: "Do the requested work",
      expected: ["Follow this Skill.", "Do the requested work"],
    },
    {
      name: "does not append an empty request part",
      template: "Follow this Skill.",
      arguments: "",
      expected: ["Follow this Skill."],
    },
    {
      name: "does not duplicate trailing text when any supported placeholder exists",
      template: "First: $1",
      arguments: "one two",
      expected: ["First: one two"],
    },
    {
      name: "keeps dynamic shell syntax literal",
      template: "Never execute !`touch forbidden`; use $1.",
      arguments: "literal",
      expected: ["Never execute !`touch forbidden`; use literal."],
    },
  ] as const

  for (const fixture of cases) {
    test(fixture.name, () => {
      expect(SkillRenderer.render({ template: fixture.template, arguments: fixture.arguments })).toEqual([
        ...fixture.expected,
      ])
    })
  }

  test("advertises zero-based indexed arguments and one-based positional placeholders", () => {
    expect(SkillRenderer.hints()).toEqual(["$ARGUMENTS", "$ARGUMENTS[N]", "$N (one-based)"])
  })
})

describe("CommandRenderer", () => {
  test("preserves one-based positions, greedy highest placeholder, and raw $ARGUMENTS", async () => {
    await expect(
      CommandRenderer.render({
        template: "$1 | $2 | $ARGUMENTS",
        arguments: '"one value" two three',
      }),
    ).resolves.toBe('one value | two three | "one value" two three')
  })
})

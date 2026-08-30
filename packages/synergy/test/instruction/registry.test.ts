import { describe, expect, test } from "bun:test"
import "../../src/product-registration"
import { InstructionRegistry } from "../../src/instruction/registry"

/**
 * H7 registration contract (S7b): after the product manifest loads, the
 * skill, command, and mcp instruction sources are mounted in the registry,
 * rendering through their domain pipelines with byte-equal semantics, and
 * unknown kinds degrade to the trimmed template instead of failing the loop.
 */
describe("InstructionRegistry source registration", () => {
  test("product registration mounts skill, command, and mcp instruction sources", () => {
    const kinds = InstructionRegistry.kinds()
    expect(kinds).toContain("skill")
    expect(kinds).toContain("command")
    expect(kinds).toContain("mcp")
  })

  test("skill source renders append-mode parts through the registry", async () => {
    await expect(
      InstructionRegistry.render("skill", { template: "Follow this Skill.", arguments: "Do the work" }),
    ).resolves.toEqual(["Follow this Skill.", "Do the work"])
    await expect(InstructionRegistry.render("skill", { template: "First: $1", arguments: "one two" })).resolves.toEqual(
      ["First: one two"],
    )
  })

  test("command source keeps engine placeholders and the raw $ARGUMENTS contract", async () => {
    await expect(
      InstructionRegistry.render("command", {
        template: "$1 | $2 | $ARGUMENTS",
        arguments: '"one value" two three',
      }),
    ).resolves.toEqual(['one value | two three | "one value" two three'])
  })

  test("mcp source renders through the same command pipeline", async () => {
    await expect(
      InstructionRegistry.render("mcp", { template: "Summarize $1", arguments: "the ticket" }),
    ).resolves.toEqual(["Summarize the ticket"])
  })

  test("skill source advertises the skill placeholder hints", () => {
    expect(InstructionRegistry.get("skill")?.hints()).toEqual(["$ARGUMENTS", "$ARGUMENTS[N]", "$N (one-based)"])
  })

  test("unknown kinds degrade to the trimmed template without substituting arguments", async () => {
    await expect(
      InstructionRegistry.render("not-registered", { template: "  Keep me.  ", arguments: "ignored" }),
    ).resolves.toEqual(["Keep me."])
  })
})

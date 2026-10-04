import { describe, expect, test } from "bun:test"
import type { JSONSchema7 } from "ai"
import { ToolIntent } from "../../src/session/tool-intent"
import { ToolResolver } from "../../src/session/tool-resolver"
import { SessionToolInput } from "../../src/session/tool-input"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"

const schema: JSONSchema7 = {
  type: "object",
  properties: { filePath: { type: "string" } },
  required: ["filePath"],
  additionalProperties: false,
}

describe("common tool intent", () => {
  test("wrapped input preserves arrays and root references through validation and persistence", () => {
    const recursive: JSONSchema7 = {
      type: "object",
      properties: { children: { type: "array", items: { $ref: "#" } } },
      additionalProperties: false,
    }
    const recursiveBinding = ToolIntent.snapshot(recursive)
    expect(recursiveBinding.inputShape).toBe("envelope")
    expect(
      ToolResolver.validateToolInput("recursive", recursiveBinding.schema, {
        toolInput: { children: [{ children: [] }] },
        workBrief: "Inspect a tree",
      }),
    ).toBeUndefined()
    const binding = ToolIntent.snapshot({ type: "array", items: { type: "string" } })
    const decoded = ToolIntent.decode(binding, { toolInput: ["a", "b"], workBrief: "Inspect labels" })
    const input = SessionToolInput.canonical(decoded.input)
    expect(input).toEqual(["a", "b"])
    expect(MessageV2.ToolStateInput.parse(input)).toEqual(input)
    expect(ToolIntent.encode(input, decoded.workBrief, decoded.inputShape)).toEqual({
      toolInput: ["a", "b"],
      workBrief: "Inspect labels",
    })
  })

  test("changing public intent cannot change duplicate-call protection", () => {
    const parts: MessageV2.Part[] = ["first", "second", "third"].map((workBrief, index) => ({
      type: "tool",
      tool: "read",
      workBrief,
      id: String(index),
      sessionID: "session",
      messageID: "message",
      callID: `call-${index}`,
      state: {
        status: "completed",
        input: { filePath: "same.txt" },
        title: "same.txt",
        output: "content",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }))
    expect(SessionProcessor.shouldAskDoomLoop(parts, "read", { filePath: "same.txt" })).toBe(true)
    expect(SessionProcessor.shouldAskDoomLoop(parts, "read", { filePath: "other.txt" })).toBe(false)
  })
  test("adds optional intent without changing the author's schema", () => {
    const source = structuredClone(schema)
    const binding = ToolIntent.snapshot(source)
    expect(binding.schema.properties?.workBrief).toEqual({ type: "string", description: ToolIntent.description })
    expect(binding.schema.required).toEqual(["filePath"])
    expect(source).toEqual(schema)
    expect(ToolIntent.decode(binding, { filePath: "README.md", workBrief: "Read the setup instructions." })).toEqual({
      input: { filePath: "README.md" },
      workBrief: "Read the setup instructions.",
      inputShape: "flat",
    })
    expect(ToolIntent.decode(binding, { filePath: "README.md", workBrief: "  " }).input).toEqual({
      filePath: "README.md",
    })
    expect(ToolIntent.decode(binding, { filePath: "README.md" }).workBrief).toBeUndefined()
  })

  test("preserves third-party fields and local references in an envelope", () => {
    const binding = ToolIntent.snapshot({
      type: "object",
      properties: { workBrief: { type: "integer" }, value: { $ref: "#/$defs/value" } },
      $defs: { value: { type: "string" } },
      required: ["workBrief"],
    })
    expect(binding.inputShape).toBe("envelope")
    const native = { workBrief: 42, value: "native" }
    const decoded = ToolIntent.decode(binding, { workBrief: "Inspect the record.", toolInput: native })
    expect(decoded.input).toEqual(native)
    expect(ToolIntent.encode(decoded.input, decoded.workBrief, decoded.inputShape)).toEqual({
      workBrief: "Inspect the record.",
      toolInput: native,
    })
    expect(binding.schema.$defs?.toolInput).toMatchObject({
      properties: { value: { $ref: "#/$defs/toolInput/$defs/value" } },
    })
  })

  test("freezes each request binding against subsequent definition updates", () => {
    const mutable = structuredClone(schema)
    const binding = ToolIntent.snapshot(mutable)
    mutable.properties!.filePath = { type: "number" }
    expect(binding.schema.properties?.filePath).toEqual({ type: "string" })
    expect(Object.isFrozen(binding.schema)).toBe(true)
  })

  test("keeps unions intact and distinguishes optional intent from required business input", () => {
    const binding = ToolIntent.snapshot({
      oneOf: [
        { type: "object", properties: { action: { const: "read" } } },
        { type: "array", items: { type: "string" } },
      ],
    })
    expect(binding.schema.required).toEqual(["toolInput"])
    expect(ToolIntent.decode(binding, { toolInput: ["a"] }).input).toEqual(["a"])
    expect(ToolIntent.encode({ command: "pwd" })).toEqual({ command: "pwd" })
  })
})

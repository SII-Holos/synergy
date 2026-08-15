import { describe, expect, test } from "bun:test"
import z from "zod"
import { tool, type ToolContext, type ToolDefinition, type ToolExposure, type ToolResult } from "../src/tool"

describe("tool()", () => {
  test("derives a Zod-typed args contract from the input", () => {
    const definition = tool({
      description: "Echo a value",
      args: { value: z.string() },
      async execute(args, context) {
        expect(context).toBeDefined()
        return { output: args.value }
      },
    })

    const parsed = z.object(definition.args).parse({ value: "ok" })
    expect(parsed.value).toBe("ok")
    expect(z.object(definition.args).safeParse({ value: 1 }).success).toBe(false)
    expect(definition.description).toBe("Echo a value")
  })

  test("preserves exposure, display, and result metadata for the host", () => {
    const exposure: ToolExposure = { mode: "group", group: "inspection", title: "Inspect" }
    const definition = tool({
      description: "Inspect",
      exposure,
      display: { kind: "media-generation", media: { type: "image", aspectRatio: "1:1" } },
      args: {},
      async execute(): Promise<string | ToolResult> {
        return { title: "Done", output: "ok", metadata: { display: { kind: "media-generation" } } }
      },
    })
    expect(definition.exposure).toEqual(exposure)
    expect(definition.display).toEqual({ kind: "media-generation", media: { type: "image", aspectRatio: "1:1" } })
  })

  test("exposes the bundled Zod for plugin-side schema reuse", () => {
    expect(tool.schema).toBe(z)
  })

  test("supports every exposure mode", () => {
    const modes: ToolExposure[] = [
      { mode: "resident" },
      { mode: "group", group: "g", title: "T", description: "D", whenToExpand: "always" },
      { mode: "search", title: "T", keywords: ["k"] },
      { mode: "internal" },
    ]
    for (const exposure of modes) {
      const definition = tool({ description: "d", exposure, args: {}, execute: async () => "ok" })
      expect(definition.exposure).toEqual(exposure)
    }
  })

  test("receives a full ToolContext during execution", async () => {
    const context: ToolContext = {
      sessionID: "ses",
      messageID: "msg",
      agent: "synergy",
      abort: new AbortController().signal,
      directory: "/tmp",
    }
    const definition = tool({
      description: "Context probe",
      args: {},
      async execute(_args, received) {
        return { output: `${received.sessionID}:${received.messageID}:${received.agent}` }
      },
    })
    const result = await definition.execute({}, context)
    expect(result).toEqual({ output: "ses:msg:synergy" })
  })

  test("ToolDefinition carries the shape used by PluginManifest compilation", () => {
    const definition: ToolDefinition = tool({
      description: "Typed",
      args: { count: z.number() },
      execute: async () => "done",
    })
    expect(z.object(definition.args).parse({ count: 3 }).count).toBe(3)
  })
})

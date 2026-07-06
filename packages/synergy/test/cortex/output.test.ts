import { describe, expect, test } from "bun:test"
import { CortexOutput } from "../../src/cortex/output"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

async function writeStructuredResult(sessionID: string, input: Record<string, unknown>) {
  const parentID = Identifier.ascending("message")
  const message = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID,
    rootID: parentID,
    mode: "test",
    agent: "developer",
    path: {
      cwd: ScopeContext.current.directory,
      root: ScopeContext.current.directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now(), completed: Date.now() },
    sessionID,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "tool",
    callID: "call_structured_task_result",
    tool: CortexOutput.STRUCTURED_TOOL_ID,
    state: {
      status: "completed",
      input,
      output: JSON.stringify(input),
      title: "Structured task result",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  })
  return message
}

async function writeAssistantText(sessionID: string, text: string) {
  const parentID = Identifier.ascending("message")
  const message = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID,
    rootID: parentID,
    mode: "test",
    agent: "developer",
    path: {
      cwd: ScopeContext.current.directory,
      root: ScopeContext.current.directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now(), completed: Date.now() },
    sessionID,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: message.id,
    sessionID,
    type: "text",
    text,
  })
  return message
}

describe("CortexOutput", () => {
  test("transportSchema wraps object, array, and union schemas with value", () => {
    const objectWrapped = CortexOutput.transportSchema({ type: "object", properties: { ok: { type: "boolean" } } })
    expect(objectWrapped).toMatchObject({ type: "object", required: ["value"], additionalProperties: false })
    expect((objectWrapped.properties as any).value.type).toBe("object")

    const arrayWrapped = CortexOutput.transportSchema({ type: "array", items: { type: "string" } })
    expect((arrayWrapped.properties as any).value.type).toBe("array")

    const anyOfWrapped = CortexOutput.transportSchema({ anyOf: [{ type: "string" }, { type: "number" }] })
    expect((anyOfWrapped.properties as any).value.anyOf).toHaveLength(2)
  })

  test("initial prompt describes value transport", () => {
    const prompt = CortexOutput.initialPrompt("Do work", {
      mode: "structured",
      schema: { type: "array", items: { type: "string" } },
    })
    expect(prompt).toContain("one field named value")
    expect(prompt).toContain("structured_task_result")
    expect(prompt).toContain('"type": "array"')
  })

  test("resolve validates tool value and ignores stale roots", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const stale = await writeStructuredResult(session.id, { value: ["old"] })
        const current = await writeStructuredResult(session.id, { value: ["new"] })

        const output = {
          mode: "structured" as const,
          schema: { type: "array", items: { type: "string" } },
        }
        const staleResult = await CortexOutput.resolve({
          sessionID: session.id,
          output,
          rootMessageID: stale.rootID!,
        })
        const currentResult = await CortexOutput.resolve({
          sessionID: session.id,
          output,
          rootMessageID: current.rootID!,
        })

        expect(staleResult).toEqual({ ok: true, output: { mode: "structured", value: ["old"] } })
        expect(currentResult).toEqual({ ok: true, output: { mode: "structured", value: ["new"] } })
      },
    })
  })

  test("resolve validates final response JSON against caller schema", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const message = await writeAssistantText(session.id, '["a", "b"]')
        const result = await CortexOutput.resolve({
          sessionID: session.id,
          rootMessageID: message.rootID!,
          output: {
            mode: "structured",
            schema: { type: "array", items: { type: "string" } },
          },
        })
        expect(result).toEqual({ ok: true, output: { mode: "structured", value: ["a", "b"] } })
      },
    })
  })

  test("renderTaskOutput renders structured JSON once", () => {
    expect(CortexOutput.renderTaskOutput({ mode: "structured", value: { choice: "yes" } })).toBe(
      'Structured output:\n{\n  "choice": "yes"\n}',
    )
  })
})

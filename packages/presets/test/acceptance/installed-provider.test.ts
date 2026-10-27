import { expect, test } from "bun:test"
import { z } from "zod"
import { installedProvider, type InstalledProviderDecision } from "./installed-provider"

test("installed provider exposes redacted decisions without suppressing repeated requests", async () => {
  const decisions: InstalledProviderDecision[] = []
  using provider = installedProvider((decision) => decisions.push(decision))
  const input = {
    stream: true,
    tools: [{ type: "function", function: { name: "bash", parameters: { properties: { workBrief: {} } } } }],
    messages: [
      { role: "system", content: "PRIVATE_FIXTURE_MARKER" },
      { role: "user", content: "Installed acceptance task\nCOMMAND_BEGIN\nprintf fixture\nCOMMAND_END" },
    ],
  }
  const frame = z.object({
    choices: z.array(
      z.object({
        delta: z.object({
          content: z.string().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .optional(),
        }),
      }),
    ),
  })
  async function request(body: unknown) {
    const response = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(response.ok).toBe(true)
    const first = (await response.text()).split("\n\n")[0]!
    return frame.parse(JSON.parse(first.slice("data: ".length))).choices[0]!.delta
  }
  const first = await request(input)
  const repeated = await request(input)
  expect(first.tool_calls?.[0]?.function.name).toBe("bash")
  expect(repeated.tool_calls?.[0]?.function.name).toBe("bash")
  expect(repeated.tool_calls?.[0]?.id).not.toBe(first.tool_calls?.[0]?.id)
  const completed = await request({
    ...input,
    messages: [
      ...input.messages,
      { role: "assistant", content: "", tool_calls: first.tool_calls },
      { role: "tool", content: "fixture", tool_call_id: first.tool_calls![0]!.id },
    ],
  })
  expect(completed.tool_calls).toBeUndefined()
  const auxiliary = await request({ ...input, tools: [] })
  expect(auxiliary.tool_calls).toBeUndefined()
  expect(decisions).toHaveLength(4)
  expect(decisions[0]).toEqual({
    sequence: 1,
    requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    stream: true,
    roles: ["system", "user"],
    userIndex: 1,
    toolCount: 1,
    outputCount: 0,
    emitsToolCall: true,
  })
  expect(decisions[1]).toEqual({ ...decisions[0]!, sequence: 2 })
  expect(decisions[2]).toMatchObject({
    sequence: 3,
    roles: ["system", "user", "assistant", "tool"],
    userIndex: 1,
    outputCount: 1,
    emitsToolCall: false,
  })
  expect(decisions[3]).toMatchObject({ sequence: 4, toolCount: 0, emitsToolCall: false })
  expect(JSON.stringify(decisions)).not.toContain("PRIVATE_FIXTURE_MARKER")
  expect(JSON.stringify(decisions)).not.toContain("printf fixture")
})

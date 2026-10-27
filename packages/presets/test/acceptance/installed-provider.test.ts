import { expect, test } from "bun:test"
import { installedProvider } from "./installed-provider"

test("installed acceptance traces tool context without suppressing repeated provider calls", async () => {
  using provider = installedProvider()
  const messages = [
    {
      role: "user",
      content: "Installed acceptance task\nCOMMAND_BEGIN\nprintf x >> effects.txt\nCOMMAND_END",
    },
  ]
  const tools = [{ type: "function", function: { name: "bash", parameters: { properties: { workBrief: {} } } } }]
  const request = async (history: Array<{ role: string; content: string; tool_call_id?: string }>) => {
    const response = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: true, tools, messages: history }),
    })
    expect(response.status).toBe(200)
    return response.text()
  }
  const first = await request(messages)
  const second = await request(messages)
  expect(provider.requests).toHaveLength(2)
  const [one, two] = provider.requests
  expect(one?.callID).toBeString()
  expect(two?.callID).toBeString()
  expect(one!.callID).not.toBe(two!.callID)
  expect(first).toContain(one!.callID!)
  expect(second).toContain(two!.callID!)
  const complete = await request([...messages, { role: "tool", content: "done", tool_call_id: two!.callID }])
  expect(complete).not.toContain('"tool_calls"')
  expect(provider.requests[2]).toEqual({
    stream: true,
    taskIndex: 0,
    roles: ["user", "tool"],
    toolOutputs: [two!.callID],
  })
  expect(Object.keys(one!).sort()).toEqual(["callID", "roles", "stream", "taskIndex", "toolOutputs"])
})

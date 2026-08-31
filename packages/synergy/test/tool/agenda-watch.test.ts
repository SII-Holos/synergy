import { describe, expect, test } from "bun:test"
import { AgendaWatchTool } from "../../src/agenda/tools/agenda-watch"

describe("agenda_watch parameters", () => {
  test("delay and onSessionEnd are mutually exclusive — neither is rejected", async () => {
    const tool = await AgendaWatchTool.init()
    expect(() => tool.parameters.parse({ title: "t", prompt: "p" })).toThrow()
  })

  test("delay and onSessionEnd are mutually exclusive — both is rejected", async () => {
    const tool = await AgendaWatchTool.init()
    expect(() =>
      tool.parameters.parse({ title: "t", prompt: "p", delay: "1h", onSessionEnd: { sessionID: "ses_x" } }),
    ).toThrow()
  })

  test("delay alone parses", async () => {
    const tool = await AgendaWatchTool.init()
    const parsed = tool.parameters.parse({ title: "t", prompt: "p", delay: "1h" })
    expect(parsed.delay).toBe("1h")
    expect(parsed.onSessionEnd).toBeUndefined()
  })

  test("onSessionEnd alone parses with optional filters", async () => {
    const tool = await AgendaWatchTool.init()
    const parsed = tool.parameters.parse({
      title: "t",
      prompt: "p",
      onSessionEnd: { sessionID: "ses_x", agent: "research", finish: "stop" },
    })
    expect(parsed.onSessionEnd).toEqual({ sessionID: "ses_x", agent: "research", finish: "stop" })
    expect(parsed.delay).toBeUndefined()
  })
})

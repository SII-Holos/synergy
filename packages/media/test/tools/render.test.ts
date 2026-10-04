import { afterAll, expect, test } from "bun:test"
import { RenderTool } from "../../src/tools/render"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("render names its artifact without confusing the call's purpose", () =>
  runtime.run(async () => {
    const tool = await RenderTool.init()
    const input = tool.parameters.parse({ html: "<p>Result</p>", artifactTitle: "Evidence summary" })
    const result = await tool.execute(input, {
      sessionID: "render-session",
      messageID: "render-message",
      agent: "synergy",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    })
    expect(result.title).toBe("Evidence summary")
    expect(result.metadata.html).toBe("<p>Result</p>")
  }))

import { afterAll, expect, test } from "bun:test"
import { RenderTool } from "../../src/tools/render"
import { testRuntime } from "../support/runtime"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"

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
    const descriptor = RenderArtifact.descriptor(result.metadata)!
    expect(descriptor.mode).toBe("interactive")
    expect(result.metadata).not.toHaveProperty("html")
    const file = await Asset.read(descriptor.source.slice("asset://".length))
    expect(RenderArtifact.Source.parse(await file!.json()).html).toBe("<p>Result</p>")
    expect(result.attachments?.[0].url).toBe(descriptor.source)
    expect(result.output).toContain("Saved")
  }))

test("render rejects oversized multibyte input and duplicate libraries", () =>
  runtime.run(async () => {
    const tool = await RenderTool.init()
    expect(tool.parameters.safeParse({ html: "中".repeat(400000) }).success).toBe(false)
    expect(tool.parameters.safeParse({ html: "<p>x</p>", libraries: ["d3", "d3"] }).success).toBe(false)
  }))

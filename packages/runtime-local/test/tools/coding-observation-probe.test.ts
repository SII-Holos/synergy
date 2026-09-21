import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ReadTool } from "../../src/tools/read"
import { ViewFileTool } from "../../src/tools/view-file"
import { ReviseFileTool } from "../../src/tools/revise-file"
import { ScanFilesTool } from "../../src/tools/scan-files"

// Fixed-input observations measure output bytes, not model tokens or task success rates.
test("coding observation probe preserves edits across a fixed read/search/edit sequence", async () => {
  const observations: { name: string; bytes: number; rows: number }[] = []
  const capture = (name: string, output: string) => {
    observations.push({
      name,
      bytes: Buffer.byteLength(output),
      rows: output.split("\n").filter((row) => /^\d+[:|]/.test(row)).length,
    })
  }
  const ctx = {
    sessionID: "coding-observation-probe",
    messageID: "",
    callID: "",
    agent: "test-strategist",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "sample.txt"),
        Array.from({ length: 1200 }, (_, i) => `row ${i + 1} ${"content ".repeat(10)}`).join("\n"),
      )
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const filePath = path.join(tmp.path, "sample.txt")
      const read = await (await ReadTool.init()).execute({ filePath, offset: 499, limit: 2 }, ctx)
      capture("read-explicit-two", read.output)
      expect(read.output).toContain("row 500 ")
      const viewTool = await ViewFileTool.init()
      const view = await viewTool.execute({ filePath, offset: 499, limit: 2 }, ctx)
      capture("view-explicit-two", view.output)
      const revise = await (
        await ReviseFileTool.init()
      ).execute({ input: `[sample.txt#${view.metadata.tag}]\nSWAP 500.=500:\n+updated row 500` }, ctx)
      capture("revise-single-line", revise.output)
      expect(await Bun.file(filePath).text()).toContain("updated row 500")
      const ranges = await viewTool.execute(
        {
          filePath,
          ranges: [
            { offset: 0, limit: 400 },
            { offset: 400, limit: 400 },
            { offset: 800, limit: 400 },
          ],
        },
        ctx,
      )
      capture("view-three-ranges", ranges.output)
      const scan = await (
        await ScanFilesTool.init()
      ).execute({ pattern: "updated row", path: tmp.path, outputMode: "files" }, ctx)
      capture("scan-full-file", scan.output)
      expect(scan.output).toContain("updated row 500")
    },
  })
  if (process.env.SYNERGY_OBSERVATION_REPORT) {
    const target = Bun.file(process.env.SYNERGY_OBSERVATION_REPORT)
    if (await target.exists()) throw new Error("Observation report already exists; choose a new output path")
    await Bun.write(target, JSON.stringify({ version: 1, observations }, null, 2))
  }
})

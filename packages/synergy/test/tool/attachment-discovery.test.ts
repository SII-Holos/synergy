import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { AttachmentDiscovery } from "../../src/tool/attachment-discovery"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("tool.attachment-discovery", () => {
  test("extracts paths from markdown, file URLs, whole lines, and inline output", () => {
    const candidates = AttachmentDiscovery.extractCandidates(
      [
        "![sheet](./contact-sheet.png)",
        "[report](file:///tmp/report.pdf)",
        "/tmp/final chart.png",
        "saved to: ./dist/result.csv",
      ].join("\n"),
    )

    expect(candidates.map((c) => c.value)).toEqual([
      "./contact-sheet.png",
      "file:///tmp/report.pdf",
      "/tmp/final chart.png",
      "./dist/result.csv",
    ])
  })

  test("discovers scope-contained attachments as asset attachment parts", async () => {
    await using tmp = await tmpdir({ git: true })
    const filepath = path.join(tmp.path, "contact-sheet.png")
    await Bun.write(filepath, "fake image")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const attachments = await AttachmentDiscovery.discover({
          output: filepath,
          cwd: tmp.path,
          sessionID: "session_test",
          messageID: "message_test",
          tool: "bash",
        })

        expect(attachments).toHaveLength(1)
        expect(attachments[0].mime).toBe("image/png")
        expect(attachments[0].filename).toBe("contact-sheet.png")
        expect(attachments[0].url.startsWith("asset://")).toBe(true)
        expect(attachments[0].localPath).toBe(filepath)
        expect(attachments[0].metadata?.kind).toBe("attachment")
      },
    })
  })

  test("rejects attachments outside the current scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    const filepath = path.join(outside.path, "leak.pdf")
    await Bun.write(filepath, "not in scope")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const attachments = await AttachmentDiscovery.discover({
          output: pathToFileURL(filepath).href,
          cwd: tmp.path,
          sessionID: "session_test",
          messageID: "message_test",
          tool: "bash",
        })

        expect(attachments).toEqual([])
      },
    })
  })

  test("dedupes and caps attachment count", async () => {
    await using tmp = await tmpdir({ git: true })
    const paths: string[] = []
    for (let i = 0; i < 10; i++) {
      const filepath = path.join(tmp.path, `attachment-${i}.pdf`)
      await Bun.write(filepath, `pdf ${i}`)
      paths.push(filepath)
    }

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const attachments = await AttachmentDiscovery.discover({
          output: [paths[0], paths[0], ...paths].join("\n"),
          cwd: tmp.path,
          sessionID: "session_test",
          messageID: "message_test",
          tool: "bash",
        })

        expect(attachments).toHaveLength(8)
        expect(new Set(attachments.map((part) => part.localPath)).size).toBe(8)
      },
    })
  })

  test("ignores unsupported files and total size overflow", async () => {
    await using tmp = await tmpdir({ git: true })
    const script = path.join(tmp.path, "script.ts")
    const pdf = path.join(tmp.path, "large.pdf")
    await Bun.write(script, "console.log('no')")
    await Bun.write(pdf, "123456789")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const attachments = await AttachmentDiscovery.discover({
          output: [script, pdf].join("\n"),
          cwd: tmp.path,
          sessionID: "session_test",
          messageID: "message_test",
          tool: "bash",
          maxTotalBytes: 4,
        })

        expect(attachments).toEqual([])
      },
    })
  })
})

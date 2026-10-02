import { describe, expect, test } from "bun:test"

const requiredFiles = [
  "lighthouserc.performance.cjs",
  "apps/web/script/visualizer-report.ts",
  "script/performance-playwright.ts",
  "script/performance-benchmark.ts",
  "script/session-memory-benchmark.ts",
  "script/session-memory-runtime-benchmark.ts",
  "script/fixtures/session-memory-trajectory.json",
  "script/performance-hyperfine.sh",
  "script/performance-http.sh",
  "script/performance-k6.js",
]

describe("optional performance tooling integration", () => {
  test("keeps concrete OSS tool entrypoints in the repository", async () => {
    for (const path of requiredFiles) {
      expect(await Bun.file(path).exists()).toBe(true)
    }
  })

  test("keeps k6 out of runtime dependencies", async () => {
    const rootPackage = await Bun.file("package.json").json()
    expect(JSON.stringify(rootPackage.dependencies ?? {})).not.toContain("k6")
  })

  test("keeps the public trajectory fixture structural and source-data free", async () => {
    const fixture = await Bun.file("script/fixtures/session-memory-trajectory.json").json()
    const serialized = JSON.stringify(fixture)
    const sessions = fixture.sessions as Array<{ messages: Array<{ role: string; originType: string; tools: any[] }> }>

    expect(fixture.provenance.kind).toBe("anonymized-completed-synergy-trajectory")
    expect(fixture.aggregate).toMatchObject({ sessions: 5, childSessions: 4, messages: 97 })
    expect(sessions.flatMap((session) => session.messages)).toHaveLength(97)
    expect(sessions.flatMap((session) => session.messages.flatMap((message) => message.tools))).toHaveLength(220)
    expect(
      sessions.flatMap((session) => session.messages.flatMap((message) => message.tools)).filter((tool) => tool.child),
    ).toHaveLength(4)
    expect(
      sessions.flatMap((session) => session.messages).filter((message) => message.originType === "cortex"),
    ).toHaveLength(4)
    for (const forbidden of ["/home/", "ses_", "msg_", "call_", "providerID", "modelID", "apiKey", "sk-"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})

import { describe, expect, test } from "bun:test"

const requiredFiles = [
  "lighthouserc.performance.cjs",
  "packages/app/script/visualizer-report.ts",
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

  test("documents k6 as optional and not a runtime dependency", async () => {
    const docs = await Bun.file("docs/operations/performance-observability.md").text()
    const rootPackage = await Bun.file("package.json").json()
    expect(docs).toContain("k6")
    expect(docs).toContain("not a runtime dependency")
    expect(JSON.stringify(rootPackage.dependencies ?? {})).not.toContain("k6")
  })

  test("documents the isolated cross-platform session memory benchmark", async () => {
    const docs = await Bun.file("docs/operations/performance-observability.md").text()
    expect(docs).toContain("perf:memory")
    expect(docs).toContain("history-projection")
    expect(docs).toContain("tool-stream")
    expect(docs).toContain("runtime footprint")
    expect(docs).toContain("perf:memory:runtime")
    expect(docs).toContain("perf:memory:runtime:matrix")
    expect(docs).toContain("deterministic local mock provider")
    expect(docs).toContain("anonymized completed Synergy trajectory")
    expect(docs).toContain("--scenario parallel")
    expect(docs).toContain("--scenario sequential")
    expect(docs).toContain("process-tree RSS")
    expect(docs).toContain("workload fingerprint")
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

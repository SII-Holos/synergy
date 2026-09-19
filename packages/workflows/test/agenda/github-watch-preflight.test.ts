import { describe, expect, test } from "bun:test"
import { GithubWatchPreflight } from "../../src/agenda/tools/github-watch-preflight"
import { GithubWatchPolicy } from "../../src/agenda/github-watch-policy"

describe("GithubWatchPreflight", () => {
  test("rejects when github.watch.enabled=false", async () => {
    const dispose = GithubWatchPolicy.register(async () => ({ enabled: false }))
    try {
      const rejected = await GithubWatchPreflight.check("agenda_watch")
      expect(rejected).toBeDefined()
      expect(rejected?.metadata.reason).toBe("github_watch_disabled")
      expect(rejected?.output).toContain("github.watch.enabled=false")
    } finally {
      dispose()
    }
  })

  test("rejects with connection steps when no credential resolves", async () => {
    const dispose = GithubWatchPolicy.register(async () => ({ enabled: true }))
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    try {
      const rejected = await GithubWatchPreflight.check("agenda_schedule")
      expect(rejected).toBeDefined()
      expect(rejected?.metadata.reason).toBe("github_credential_missing")
      expect(rejected?.output).toContain("Settings → GitHub")
      expect(rejected?.output).toContain("Do not substitute a timed delay loop")
    } finally {
      dispose()
    }
  })

  test("passes when a credential resolves from the environment", async () => {
    const dispose = GithubWatchPolicy.register(async () => ({ enabled: true }))
    process.env.GH_TOKEN = "test-token"
    try {
      expect(await GithubWatchPreflight.check("agenda_watch")).toBeUndefined()
    } finally {
      delete process.env.GH_TOKEN
      dispose()
    }
  })
})

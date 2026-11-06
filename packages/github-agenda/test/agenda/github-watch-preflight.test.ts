import { expect, test } from "bun:test"
import { GithubWatchPreflight } from "@ericsanchezok/synergy-agenda/agenda/tools/github-watch-preflight"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "../support/runtime"

test.each([
  { enabled: false, token: undefined, reason: "github_watch_disabled" },
  { enabled: true, token: undefined, reason: "github_credential_missing" },
  { enabled: true, token: "test-token", reason: undefined },
])("GitHub watch preflight respects policy and Runtime credentials: %j", async ({ enabled, token, reason }) => {
  await using runtime = await testRuntime({ GH_TOKEN: token, GITHUB_TOKEN: undefined })
  await runtime.run(async () => {
    await using tmp = await tmpdir({ config: { github: { watch: { enabled } } } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const rejected = await GithubWatchPreflight.check("agenda_watch")
        if (!reason) {
          expect(rejected).toBeUndefined()
          return
        }
        expect(rejected?.metadata.reason).toBe(reason)
        if (reason === "github_watch_disabled") expect(rejected?.output).toContain("github.watch.enabled=false")
        else {
          expect(rejected?.output).toContain("Settings → GitHub")
          expect(rejected?.output).toContain("Do not substitute a timed delay loop")
        }
      },
    })
  })
})

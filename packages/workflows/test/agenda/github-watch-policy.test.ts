import { expect, test } from "bun:test"
import { GithubWatchPolicy } from "../../src/agenda/github-watch-policy"

test("GitHub watches require an explicitly installed policy source", async () => {
  await expect(GithubWatchPolicy.read()).rejects.toThrow("GitHub watch policy is not registered")
  const dispose = GithubWatchPolicy.register(async () => ({ enabled: false, defaultIntervalMs: 1234 }))
  try {
    expect(await GithubWatchPolicy.read()).toEqual({ enabled: false, defaultIntervalMs: 1234 })
  } finally {
    dispose()
  }
  await expect(GithubWatchPolicy.read()).rejects.toThrow("GitHub watch policy is not registered")
})

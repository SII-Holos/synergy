import { expect, test } from "bun:test"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

const files = [
  "test/holos/profile.test.ts",
  "test/holos/presence.test.ts",
  "test/tools/synergy-link-execution.test.ts",
  "test/channel/clarus-abort.test.ts",
  "test/channel/tool-policy.test.ts",
  "test/channel/refresh.test.ts",
  "test/channel/feishu-response-card.test.ts",
  "test/channel/feishu-acceptance-lane.test.ts",
  "test/channel/outbound-parts.test.ts",
  "test/channel/clarus-routing.test.ts",
  "test/channel/feishu-streaming-image.test.ts",
  "test/channel/clarus-extension-deadline.test.ts",
  "test/channel/clarus-routing-provider.test.ts",
  "test/session/session.test.ts",
  "test/channel/provider/github/poll.test.ts",
  "test/channel/provider/github/workspace.test.ts",
  "test/channel/provider/github/workspace-ownership.test.ts",
]

test("repeat the Channel CI batch with observed Runtime close phases", async () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    process.stderr.write(`CHANNEL_BATCH_ATTEMPT ${attempt}\n`)
    const isolated = await createIsolatedTestEnv()
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "--timeout", "30000", "--coverage", "--coverage-reporter=text", ...files],
      cwd: path.resolve(import.meta.dir, "../.."),
      env: isolated.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      process.stdout.write(stdout)
      process.stderr.write(stderr)
      expect(code).toBe(0)
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await isolated.dispose()
    }
  }
}, 240000)

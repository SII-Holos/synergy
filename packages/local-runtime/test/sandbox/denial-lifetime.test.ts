import { expect, mock, spyOn, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import * as Diagnostics from "../../src/sandbox/macos-diagnostics"
import { SandboxBackend } from "../../src/sandbox/backend"
import { LocalBashBackend } from "../../src/tools/bash/local"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

for (const fail of [false, true]) {
  test.skipIf(process.platform !== "darwin")(
    `local Bash releases its denial stream on ${fail ? "setup failure" : "success"}`,
    () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({ git: true })
        const stop = mock(() => {})
        const start = spyOn(Diagnostics, "startDenialLogger").mockReturnValue({
          pid: undefined,
          output: [],
          adoptPid() {},
          stop,
          async flush() {
            stop()
          },
        })
        try {
          await ScopeContext.provide({
            scope: await tmp.scope(),
            fn: async () => {
              const result = LocalBashBackend.execute(
                { command: "printf done", description: "fixture", yieldSeconds: 0 },
                {
                  sessionID: "fixture",
                  messageID: "fixture",
                  agent: "test",
                  abort: new AbortController().signal,
                  metadata() {},
                  async ask() {},
                  ...(fail
                    ? {
                        async openProcessEvidence(): Promise<never> {
                          throw new Error("fixture setup failed")
                        },
                      }
                    : {}),
                  extra: {
                    shellAuthorizationResolved: true,
                    sandboxPrepare: async ({ command }: { command: string }) => ({
                      command: "/bin/sh",
                      args: ["-c", command],
                      sandboxed: true,
                    }),
                  },
                },
              )
              if (fail) await expect(result).rejects.toThrow("fixture setup failed")
              else expect((await result).output).toContain("done")
              expect(start).toHaveBeenCalledTimes(1)
              expect(stop).toHaveBeenCalled()
            },
          })
        } finally {
          start.mockRestore()
        }
      }),
  )
}

test.skipIf(process.platform !== "darwin")("sandbox spawn-hook failure releases its denial stream", () =>
  runtime.run(async () => {
    const stop = mock(() => {})
    const start = spyOn(Diagnostics, "startDenialLogger").mockReturnValue({
      pid: undefined,
      output: [],
      adoptPid() {},
      stop,
      async flush() {
        stop()
      },
    })
    try {
      await expect(
        SandboxBackend.executeAsync(
          { command: "/bin/sh", args: ["-c", "sleep 1"], sandboxed: true },
          {
            fallbackPolicy: "deny",
            after_spawn() {
              throw new Error("fixture hook failed")
            },
          },
        ),
      ).rejects.toThrow("fixture hook failed")
      expect(stop).toHaveBeenCalled()
    } finally {
      start.mockRestore()
    }
  }),
)

afterRuntimeTests(() => runtime.close())

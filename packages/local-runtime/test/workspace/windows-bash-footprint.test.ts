import { expect, test } from "bun:test"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { LocalBashBackend } from "../../src/tools/bash/local"
import { testRuntime } from "../support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { shell } from "../../src/session/shell"

test.skipIf(process.platform !== "win32")(
  "user shell with cmd preserves quoted executables, script paths and arguments",
  async () => {
    await using runtime = await testRuntime({
      env: { SHELL: process.env.ComSpec ?? "cmd.exe", COMSPEC: process.env.ComSpec ?? "cmd.exe" },
    })
    await using directory = await tmpdir()
    await runtime.run(async () =>
      ScopeContext.provide({
        scope: await directory.scope(),
        fn: async () => {
          const session = await Session.create()
          const script = path.join(directory.path, "quoted script.mjs")
          const values = ["space value", "a&b", "中文", ""]
          await Bun.write(script, "console.log(JSON.stringify(process.argv.slice(2)))")
          try {
            const result = await shell({
              sessionID: session.id,
              agent: "synergy",
              model: { providerID: "test", modelID: "test" },
              command: [process.execPath, script, ...values].map((value) => `"${value}"`).join(" "),
            })
            const state = result.parts[0]?.state
            expect(state?.status).toBe("completed")
            if (state?.status !== "completed") throw new Error("Expected completed user shell")
            expect(JSON.parse(state.output.trim())).toEqual(values)
          } finally {
            await Session.remove(session.id)
          }
        },
      }),
    )
  },
  30000,
)

test.skipIf(process.platform !== "win32")(
  "owned Windows Bash preserves cmd percent loops and quoted file paths",
  async () => {
    await using runtime = await testRuntime({
      env: { SHELL: process.env.ComSpec ?? "cmd.exe", COMSPEC: process.env.ComSpec ?? "cmd.exe" },
    })
    await using directory = await tmpdir()
    await runtime.run(async () =>
      ScopeContext.provide({
        scope: await directory.scope(),
        fn: async () => {
          const filename = path.join(directory.path, "quoted file.txt")
          const result = await LocalBashBackend.execute(
            {
              command: `for %i in (one two) do @echo %i>>"${filename}"`,
              description: "cmd quoting probe",
              yieldSeconds: 10,
            },
            {
              sessionID: "cmd-owner",
              messageID: "message",
              agent: "synergy",
              abort: new AbortController().signal,
              metadata() {},
              async ask() {},
              extra: { shellBypassSandbox: true },
            },
          )
          expect(result.metadata.exit).toBe(0)
          expect((await Bun.file(filename).text()).trim().split(/\r?\n/)).toEqual(["one", "two"])
        },
      }),
    )
  },
  30000,
)

import { expect, test } from "bun:test"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { LocalBashBackend } from "../../src/tools/bash/local"
import { testRuntime } from "../support/runtime"

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

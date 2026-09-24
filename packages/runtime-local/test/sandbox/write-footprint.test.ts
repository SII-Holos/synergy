import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SandboxBackend } from "../../src/sandbox/backend"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test.skipIf(process.platform !== "darwin")(
  "compiled macOS footprint covers actual writes without sharing the host temporary directory",
  () =>
    runtime.run(async () => {
      await using a = await tmpdir()
      await using b = await tmpdir()
      const external = path.join("/var/tmp", `synergy-footprint-${crypto.randomUUID()}`)
      await fs.writeFile(external, "unchanged")
      try {
        for (const mode of ["read_only", "workspace_write"] as const) {
          const command = "/bin/sh"
          const run = (target: string) => {
            const wrapper = SandboxBackend.prepareWrapper({
              command,
              args: ["-c", 'printf updated > "$1"', "probe", target],
              workspace: a.path,
              sandboxMode: mode,
              extraWritableRoots: [b.path],
            })
            try {
              expect(wrapper.writeFootprint).toEqual({
                kind: "roots",
                roots: mode === "read_only" ? [] : [a.path, b.path],
              })
              return Bun.spawnSync([wrapper.command, ...wrapper.args], { stdout: "pipe", stderr: "pipe" }).exitCode
            } finally {
              SandboxBackend.cleanupWrapper(wrapper)
            }
          }
          expect(run(external)).not.toBe(0)
          const result = run(path.join(b.path, mode))
          expect(result === 0).toBe(mode === "workspace_write")
          expect(await fs.readFile(external, "utf8")).toBe("unchanged")
        }
      } finally {
        await fs.rm(external, { force: true })
      }
    }),
)

test("Linux helper footprint includes its host-backed controlled temporary mount", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    for (const mode of ["workspace_write", "read_only"] as const) {
      const wrapper = SandboxBackend.prepareWrapper({
        command: "/bin/true",
        args: [],
        workspace: tmp.path,
        sandboxMode: mode,
        forcePlatform: "linux",
        forceHelperPath: "/usr/local/bin/synergy-sandbox-linux",
        forceHelperVerified: true,
      })
      try {
        expect(wrapper.writeFootprint).toEqual({
          kind: "roots",
          roots:
            mode === "read_only"
              ? [path.join(tmp.path, ".synergy", "tmp")]
              : [tmp.path, path.join(tmp.path, ".synergy", "tmp")],
        })
      } finally {
        SandboxBackend.cleanupWrapper(wrapper)
      }
    }
  }))

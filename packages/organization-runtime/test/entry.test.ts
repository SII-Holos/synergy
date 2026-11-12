import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

const installed = process.env.SYNERGY_TEST_ORGANIZATION_RUNTIME_INSTALL
const entry = installed
  ? path.join(installed, "node_modules/.bin/synergy-org-runtime")
  : path.resolve(import.meta.dir, "../src/entry.ts")

test("the independent Runtime entry discovers only machine commands and rejects private input without ambient writes", async () => {
  const isolation = await createIsolatedTestEnv()
  try {
    const invoke = async (args: string[], input: string) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", entry, ...args], {
        cwd: installed ?? isolation.env.SYNERGY_TEST_HOME,
        env: {
          ...isolation.env,
          SYNERGY_HOME: isolation.env.SYNERGY_TEST_HOME,
          SYNERGY_RUNTIME_ROOT: undefined,
          NODE_PATH: undefined,
          NODE_OPTIONS: undefined,
        },
        stdin: new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    const help = await invoke(["--help"], "")
    expect(help.code, help.stderr).toBe(0)
    expect(help.stdout).toContain("synergy-org-runtime hosted-runtime")
    expect(help.stdout).not.toContain("send [message..]")
    const invalid = await invoke(["hosted-runtime"], "private-input-must-not-appear")
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain("supervisor request")
    expect(invalid.stdout + invalid.stderr).not.toContain("private-input-must-not-appear")
    expect((await invoke(["unknown"], "")).code).toBe(1)
    expect(await fs.readdir(isolation.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    await isolation.dispose()
  }
}, 30_000)

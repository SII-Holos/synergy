import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("the measured standalone source entry executes discovery without opening its Home", async () => {
  const isolated = await createIsolatedTestEnv()
  const names = ["SYNERGY_HOME", "SYNERGY_RUNTIME_ROOT"] as const
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  const argv = process.argv
  const code = process.exitCode ?? 0
  const home = path.join(isolated.env.SYNERGY_TEST_ROOT!, "unopened-source-entry")
  const output: string[] = []
  const log = spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    output.push(values.map(String).join(" "))
  })
  try {
    process.env.SYNERGY_HOME = home
    delete process.env.SYNERGY_RUNTIME_ROOT
    process.argv = [process.execPath, path.resolve(import.meta.dir, "../src/entry.ts"), "--help"]
    process.exitCode = 0
    await import("../src/entry")
    expect(process.exitCode).toBe(0)
    expect(output.join("\n")).toContain("synergy-org init")
    expect(output.join("\n")).toContain("synergy-org serve")
    expect(output.join("\n")).not.toContain("send [message..]")
    expect(await Bun.file(path.join(home, "data/storage/agent.sqlite")).exists()).toBe(false)
    expect(await fs.readdir(isolated.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    log.mockRestore()
    process.argv = argv
    process.exitCode = code
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await isolated.dispose()
  }
})

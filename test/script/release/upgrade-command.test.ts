import { $ } from "bun"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { upgradeCommand } from "./upgrade-command"

test.each(["silent", "stdout"] as const)("upgrade %s command preserves every filesystem effect", async (output) => {
  await using resources = testResources()
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-upgrade-command-"))
  resources.defer("command workspace", () => rm(directory, { recursive: true, force: true }))
  const marker = "FILE_0123456789abcdef0123456789abcdef\n"
  await Bun.write(path.join(directory, "record.txt"), marker)
  for (const effects of ["x", "xx"]) {
    const result = await $`${{ raw: upgradeCommand("result.txt", output) }}`.cwd(directory).quiet().nothrow()
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe("")
    expect(result.stdout.toString()).toBe(output === "stdout" ? marker : "")
    expect(await Bun.file(path.join(directory, "result.txt")).text()).toBe(marker)
    expect(await Bun.file(path.join(directory, "effects.txt")).text()).toBe(effects)
  }
})

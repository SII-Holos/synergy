import { expect, test } from "bun:test"
import path from "node:path"
import { chmod, mkdir } from "node:fs/promises"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Ripgrep } from "../../src/file/ripgrep"

test("tool lookup belongs to its Runtime Home and environment", async () => {
  await using first = await runtimeHome()
  await using second = await runtimeHome()
  const contexts = [first, second].map(({ host }) => RuntimeContext.create({ ...host, env: { ...host.env, PATH: "" } }))
  const paths = [first, second].map(({ host }) =>
    path.join(host.root, "bin", process.platform === "win32" ? "rg.exe" : "rg"),
  )
  try {
    for (const file of paths) {
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, "isolated executable fixture")
      await chmod(file, 0o755)
    }
    expect(await contexts[0]!.run(Ripgrep.filepath)).toBe(paths[0]!)
    expect(await contexts[1]!.run(Ripgrep.filepath)).toBe(paths[1]!)
    contexts[0]!.dispose()
    expect(await contexts[1]!.run(Ripgrep.filepath)).toBe(paths[1]!)
  } finally {
    for (const context of contexts) context.dispose()
  }
})

test.skipIf(!Bun.which("rg"))("search processes use their Runtime environment", async () => {
  await using first = await runtimeHome()
  await using second = await runtimeHome()
  const directory = path.join(first.host.home, "files")
  await mkdir(directory)
  for (const name of ["first.txt", "second.txt"]) await Bun.write(path.join(directory, name), "needle\n")
  const contexts: RuntimeContext.Instance[] = []
  try {
    for (const [index, fixture] of [first, second].entries()) {
      const config = path.join(fixture.host.home, "ripgrep-config")
      await Bun.write(config, `--glob=!${index === 0 ? "first" : "second"}.txt\n`)
      contexts.push(
        RuntimeContext.create({ ...fixture.host, env: { ...fixture.host.env, RIPGREP_CONFIG_PATH: config } }),
      )
    }
    for (const [index, context] of contexts.entries()) {
      await context.run(async () => {
        const expected = index === 0 ? "second.txt" : "first.txt"
        const files: string[] = []
        for await (const file of Ripgrep.files({ cwd: directory })) files.push(path.basename(file))
        expect(files).toEqual([expected])
        const matches = await Ripgrep.search({ cwd: directory, pattern: "needle" })
        expect(matches.map((match) => path.basename(match.path.text))).toEqual([expected])
      })
    }
  } finally {
    for (const context of contexts) context.dispose()
  }
})

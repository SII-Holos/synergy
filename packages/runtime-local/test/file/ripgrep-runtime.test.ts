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

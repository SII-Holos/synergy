import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareInstallation, listInstalledPackages } from "../../src/installation/manager"

test("installation plans remain inert until trusted, retain explicit roots, and remove by component id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-installer-"))
  try {
    const directory = path.join(root, "fixture")
    const marker = path.join(root, "evaluated")
    await Bun.write(path.join(directory, "component.js"), `await Bun.write(${JSON.stringify(marker)}, "bad")`)
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "example-extension",
        version: "2.0.0",
        type: "module",
        synergy: {
          formatVersion: 1,
          kind: "component",
          id: "example",
          version: "2.0.0",
          compatibility: { synergy: "^2.0.0" },
          apiVersion: 1,
          entry: "./component.js",
          export: "example",
        },
      }),
    )
    await using plan = await prepareInstallation(root, { hostVersion: "2.0.0", sources: [directory] })
    expect(plan.changes.map((item) => [item.action, item.id, item.kind])).toEqual([["install", "example", "component"]])
    expect(await listInstalledPackages(root)).toEqual([])
    await expect(plan.commit({ trustHostCode: false })).rejects.toThrow("Explicit trust")
    await plan.commit({ trustHostCode: true })
    expect(await listInstalledPackages(root)).toMatchObject([
      { name: "example-extension", id: "example", explicit: true },
    ])
    expect(await Bun.file(marker).exists()).toBe(false)
    await Bun.write(path.join(directory, "component.js"), "export const updated = true")
    await using replacement = await prepareInstallation(root, { hostVersion: "2.0.0", sources: [directory] })
    expect(replacement.changes).toMatchObject([{ action: "update", id: "example", version: "2.0.0" }])
    await replacement.commit({ trustHostCode: true })
    await using removal = await prepareInstallation(root, { hostVersion: "2.0.0", remove: ["example"] })
    expect(removal.changes.map((item) => item.action)).toEqual(["remove"])
    await removal.commit({ trustHostCode: true })
    expect(await listInstalledPackages(root)).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

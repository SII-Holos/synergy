import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { InstallationGenerations } from "../../src/installation/generations"

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-generation-test-"))
  return { root, [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }) }
}

async function stage(root: string, value = "safe") {
  const directory = await InstallationGenerations.stage(root)
  await Bun.write(
    path.join(directory, "node_modules/example/component.js"),
    `export const value = ${JSON.stringify(value)}`,
  )
  return directory
}

const component = {
  formatVersion: 1 as const,
  kind: "component" as const,
  apiVersion: 1 as const,
  id: "example",
  version: "2.0.0",
  compatibility: { synergy: "^2.0.0" },
  entry: "./component.js",
  export: "example",
}
const packages = {
  example: { directory: "node_modules/example", version: "2.0.0", spec: "example@2.0.0", metadata: component },
}
const input = (directory: string) => ({
  directory,
  hostVersion: "2.0.0",
  roots: { example: "2.0.0" },
  packages,
  trustHostCode: true,
})

test("commits an immutable verified generation and rejects stale install plans", async () => {
  await using temp = await fixture()
  const first = await InstallationGenerations.commit(temp.root, input(await stage(temp.root)))
  expect((await InstallationGenerations.current(temp.root))?.id).toBe(first.id)
  const second = await InstallationGenerations.commit(temp.root, {
    ...input(await stage(temp.root, "new")),
    previous: first.id,
  })
  expect(second.id).not.toBe(first.id)
  expect(await Bun.file(path.join(first.directory, "node_modules/example/component.js")).text()).toContain("safe")
  await expect(
    InstallationGenerations.commit(temp.root, { ...input(await stage(temp.root)), previous: first.id }),
  ).rejects.toThrow("changed")
  expect((await InstallationGenerations.current(temp.root))?.id).toBe(second.id)
})

test("does not activate host code without explicit trust or after tampering", async () => {
  await using temp = await fixture()
  const directory = await stage(temp.root)
  await expect(
    InstallationGenerations.commit(temp.root, { ...input(directory), trustHostCode: false }),
  ).rejects.toThrow("trust")
  expect(await InstallationGenerations.current(temp.root)).toBeUndefined()
  const generation = await InstallationGenerations.commit(temp.root, input(directory))
  await Bun.write(path.join(generation.directory, "node_modules/example/component.js"), "throw new Error('tampered')")
  await expect(InstallationGenerations.current(temp.root)).rejects.toThrow("integrity")
})

test("rejects packages with external symlinks and incompatible host versions", async () => {
  await using temp = await fixture()
  const directory = await stage(temp.root)
  await fs.symlink(path.join(temp.root, "outside"), path.join(directory, "escape"))
  await Bun.write(path.join(temp.root, "outside"), "not owned")
  await expect(InstallationGenerations.commit(temp.root, input(directory))).rejects.toThrow("escapes")
  await fs.unlink(path.join(directory, "escape"))
  await expect(
    InstallationGenerations.commit(temp.root, { ...input(directory), hostVersion: "3.0.0" }),
  ).rejects.toThrow("requires Synergy")
})

test("recovers an unpublished promotion and retains a committed generation", async () => {
  await using temp = await fixture()
  const first = await InstallationGenerations.commit(temp.root, input(await stage(temp.root)))
  const pointerFile = path.join(temp.root, "installations/active.json")
  const firstPointer = await Bun.file(pointerFile).json()
  const second = await InstallationGenerations.commit(temp.root, {
    ...input(await stage(temp.root)),
    previous: first.id,
  })
  const secondPointer = await Bun.file(pointerFile).json()
  const intentFile = path.join(temp.root, "installations/pending.json")
  await Bun.write(intentFile, JSON.stringify({ version: 1, previous: firstPointer, next: secondPointer }))
  expect((await InstallationGenerations.current(temp.root))?.id).toBe(second.id)
  expect(await Bun.file(intentFile).exists()).toBe(false)

  await Bun.write(pointerFile, JSON.stringify(firstPointer))
  await Bun.write(intentFile, JSON.stringify({ version: 1, previous: firstPointer, next: secondPointer }))
  expect((await InstallationGenerations.current(temp.root))?.id).toBe(first.id)
  expect(await fs.stat(second.directory).catch(() => undefined)).toBeUndefined()
})

test("retains version floors after removal so code rollback cannot reopen upgraded data", async () => {
  await using temp = await fixture()
  const first = await InstallationGenerations.commit(temp.root, input(await stage(temp.root)))
  const removed = await InstallationGenerations.commit(temp.root, {
    ...input(await stage(temp.root)),
    previous: first.id,
    roots: {},
    packages: {},
  })
  const older = { ...component, version: "1.0.0" }
  await expect(
    InstallationGenerations.commit(temp.root, {
      ...input(await stage(temp.root)),
      previous: removed.id,
      packages: { example: { ...packages.example, version: "1.0.0", metadata: older } },
    }),
  ).rejects.toThrow("downgrade")
  await expect(
    InstallationGenerations.commit(temp.root, {
      ...input(await stage(temp.root)),
      previous: removed.id,
      hostVersion: "1.0.0",
      packages: {},
    }),
  ).rejects.toThrow("downgrade")
})

test("rejects dependency cycles before component code can be loaded", async () => {
  await using temp = await fixture()
  const directory = await stage(temp.root)
  await expect(
    InstallationGenerations.commit(temp.root, {
      ...input(directory),
      packages: { example: { ...packages.example, metadata: { ...component, requires: { example: "2.0.0" } } } },
    }),
  ).rejects.toThrow("cycle")
  expect(await InstallationGenerations.current(temp.root)).toBeUndefined()
})

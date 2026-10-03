import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { identifyDirectory as legacyDirectory } from "@ericsanchezok/synergy-util/filesystem-identity"
import { identifyDirectory } from "../../src/workspace/identity"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { openLocalRuntime } from "../../src"
import { createHash } from "node:crypto"
import { NativeWorkspaceFiles } from "../../src/workspace/file-host"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { migrateNativeMountIdentities } from "../../src/workspace/identity-migration"

test.skipIf(process.platform !== "darwin")(
  "local identity uses a persistent volume and retains upgrade evidence",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "workspace")
    await fs.mkdir(directory)
    const initial = await identifyDirectory(directory)
    expect(initial.physicalID).toStartWith("volume-v1:")
    expect(initial.legacyPhysicalID).toBe((await legacyDirectory(directory)).physicalID)
    await fs.writeFile(path.join(directory, "file"), "changed")
    expect((await identifyDirectory(directory)).physicalID).toBe(initial.physicalID)
    await fs.rename(directory, path.join(tmp.path, "previous"))
    await fs.mkdir(directory)
    expect((await identifyDirectory(directory)).physicalID).not.toBe(initial.physicalID)
  },
)

test.skipIf(process.platform !== "darwin")(
  "identity upgrade preserves generations and never adopts replaced or missing directories",
  async () => {
    await using fixture = await runtimeHome()
    const host = {
      ...fixture.host,
      workspaceLocation: { ...fixture.host.workspaceLocation!, identify: identifyDirectory },
    }
    await using runtime = await openLocalRuntime({ host, mode: "oneshot" })
    await runtime.run(async () => {
      const records = []
      const hostID = await host.workspaceLocation.hostID()
      for (const name of ["kept", "replaced", "missing", "foreign"]) {
        const directory = path.join(host.home, name)
        await fs.mkdir(directory)
        const identity = await legacyDirectory(directory)
        records.push(
          await WorkspaceCatalog.register({
            scopeID: "identity-upgrade",
            type: "main",
            hostID: name === "foreign" ? "another-host" : hostID,
            path: identity.path,
            physicalID: identity.physicalID,
          }),
        )
      }
      await fs.rename(records[1].binding.path!, path.join(host.home, "previous"))
      await fs.mkdir(records[1].binding.path!)
      await fs.rm(records[2].binding.path!, { recursive: true })
      const migration = MigrationRegistry.list()
        .get("workspace")!
        .find((item) => item.id === "20261003-persistent-volume-identity")!
      await migration.up(() => {})
      const kept = await WorkspaceCatalog.get(records[0].id, "identity-upgrade")
      expect(kept.binding.physicalID).toStartWith("volume-v1:")
      expect(kept.binding.generation).toBe(records[0].binding.generation)
      expect(kept.revision).toBe(records[0].revision + 1)
      expect(
        await WorkspaceCatalog.register({
          scopeID: kept.scopeID,
          type: kept.type,
          hostID,
          path: kept.binding.path!,
          physicalID: kept.binding.physicalID,
        }),
      ).toEqual(kept)
      for (const record of records.slice(1))
        expect(await WorkspaceCatalog.get(record.id, record.scopeID)).toEqual(record)
      await migration.up(() => {})
      expect(await WorkspaceCatalog.get(kept.id, kept.scopeID)).toEqual(kept)
    })
  },
  30_000,
)

test.skipIf(process.platform !== "darwin")(
  "native mount receipts upgrade before inspection without accepting a replacement",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "environments", "environment", "allocation", "workspace")
    const host = new NativeWorkspaceFiles({
      directory,
      materializationRoot: path.join(tmp.path, "views"),
      coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") }),
    })
    try {
      for (const id of ["kept", "replaced"]) {
        const root = path.join(tmp.path, id)
        await fs.mkdir(root)
        const reference = { id, workspaceID: id, generation: 1 }
        await host.mount({ ...reference, readOnly: true, source: { kind: "directory", path: root } })
        const file = path.join(directory, "mounts", createHash("sha256").update(id).digest("hex"))
        const receipt = await Bun.file(file).json()
        receipt.mount.physicalID = (await legacyDirectory(root)).physicalID
        await Bun.write(file, JSON.stringify(receipt))
      }
      await fs.rename(path.join(tmp.path, "replaced"), path.join(tmp.path, "old"))
      await fs.mkdir(path.join(tmp.path, "replaced"))
      await migrateNativeMountIdentities(path.join(tmp.path, "environments"), () => {})
      const reference = { id: "kept", workspaceID: "kept", generation: 1 }
      const current = await host.inspect(reference)
      expect(current?.physicalID).toStartWith("volume-v1:")
      expect(current?.generation).toBe(1)
      await migrateNativeMountIdentities(path.join(tmp.path, "environments"), () => {})
      expect(await host.inspect(reference)).toEqual(current)
      await expect(host.inspect({ id: "replaced", workspaceID: "replaced", generation: 1 })).rejects.toThrow("changed")
    } finally {
      await host.close()
    }
  },
)

test.skipIf(process.platform !== "darwin")(
  "invalid mount receipts retain evidence without blocking verified identities or granting admission",
  async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "environments")
    const directory = path.join(root, "environment", "allocation", "workspace")
    const host = new NativeWorkspaceFiles({
      directory,
      materializationRoot: path.join(tmp.path, "views"),
      coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") }),
    })
    try {
      const source = path.join(tmp.path, "source")
      await fs.mkdir(source)
      const reference = { id: "kept", workspaceID: "kept", generation: 1 }
      await host.mount({ ...reference, readOnly: true, source: { kind: "directory", path: source } })
      const file = path.join(directory, "mounts", createHash("sha256").update(reference.id).digest("hex"))
      const receipt = await Bun.file(file).json()
      receipt.mount.physicalID = (await legacyDirectory(source)).physicalID
      await Bun.write(file, JSON.stringify(receipt))
      const malformed = ["{", "null", JSON.stringify({ input: null, digest: 1 })]
      for (const [index, raw] of malformed.entries())
        await Bun.write(
          path.join(directory, "mounts", createHash("sha256").update(`invalid-${index}`).digest("hex")),
          raw,
        )
      const progress: number[] = []
      await migrateNativeMountIdentities(root, (current, total) => {
        expect(total).toBe(4)
        progress.push(current)
      })
      expect(progress).toEqual([1, 2, 3, 4])
      expect((await host.inspect(reference))?.physicalID).toStartWith("volume-v1:")
      for (const [index, raw] of malformed.entries()) {
        const id = `invalid-${index}`
        const filename = createHash("sha256").update(id).digest("hex")
        const evidence = path.join(directory, "identity-migration-issues", filename)
        expect(await Bun.file(path.join(directory, "mounts", filename)).text()).toBe(raw)
        expect(await Bun.file(evidence).json()).toEqual({
          reason: "invalid-receipt",
          sha256: createHash("sha256").update(raw).digest("hex"),
        })
        expect((await fs.stat(evidence)).mode & 0o777).toBe(0o600)
        await expect(host.inspect({ id, workspaceID: id, generation: 1 })).rejects.toThrow()
      }
      const upgraded = await Bun.file(file).text()
      await migrateNativeMountIdentities(root, () => {})
      expect(await Bun.file(file).text()).toBe(upgraded)
      expect(await fs.readdir(path.join(directory, "identity-migration-issues"))).toHaveLength(3)
    } finally {
      await host.close()
    }
  },
)

test.skipIf(process.platform !== "darwin")("mount migration keeps read and evidence-write failures fatal", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "environment", "allocation", "workspace")
  const file = path.join(directory, "mounts", "invalid")
  await Bun.write(file, "{")
  await fs.chmod(file, 0)
  try {
    await expect(migrateNativeMountIdentities(tmp.path, () => {})).rejects.toThrow("EACCES")
  } finally {
    await fs.chmod(file, 0o600)
  }
  await Bun.write(path.join(directory, "identity-migration-issues"), "occupied")
  await expect(migrateNativeMountIdentities(tmp.path, () => {})).rejects.toThrow("EEXIST")
  expect(await Bun.file(file).text()).toBe("{")
})

import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ObservabilityIssues } from "../../src/observability/issues"

function identity(label: string) {
  return {
    channelType: "clarus",
    accountId: `agent-${label}`,
    externalProjectId: `project-${label}`,
  }
}

describe("Channel managed Project ownership", () => {
  test("concurrent ensure creates one Scope and resolves in both directions", async () => {
    const input = identity(crypto.randomUUID())
    const records = await Promise.all(
      Array.from({ length: 8 }, () =>
        ManagedProjectOwnership.ensure({
          ...input,
          projectName: "Remote project",
          remoteState: "active",
        }),
      ),
    )

    expect(new Set(records.map((record) => record.scopeID))).toEqual(new Set([records[0]!.scopeID]))
    expect(new Set(records.map((record) => record.directory))).toEqual(new Set([records[0]!.directory]))
    expect(await ManagedProjectOwnership.find(input)).toMatchObject({
      scopeID: records[0]!.scopeID,
      directory: records[0]!.directory,
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
    expect(await ManagedProjectOwnership.findByScopeID(records[0]!.scopeID)).toMatchObject({
      scopeID: records[0]!.scopeID,
      directory: records[0]!.directory,
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
    expect(await Scope.fromID(records[0]!.scopeID)).toMatchObject({
      id: records[0]!.scopeID,
      directory: records[0]!.directory,
    })
  })

  test("initializes Git and refreshes lastSeenAt for repeated authoritative discovery", async () => {
    const input = identity(crypto.randomUUID())
    const first = await ManagedProjectOwnership.ensure({ ...input, remoteState: "active" })
    await Bun.sleep(2)

    const second = await ManagedProjectOwnership.ensure({ ...input, remoteState: "active" })

    expect((await fs.stat(path.join(second.directory, ".git"))).isDirectory()).toBe(true)
    expect(second.lastSeenAt).toBeGreaterThan(first.lastSeenAt)
  })
  test("initializes an independent Git repository even below an ancestor .git directory", async () => {
    const ancestorGit = path.join(Global.Path.data, "channel", "workspaces", ".git")
    await fs.mkdir(ancestorGit, { recursive: true })
    try {
      const record = await ManagedProjectOwnership.ensure({
        ...identity(crypto.randomUUID()),
        remoteState: "active",
      })

      const topLevel = (await $`git rev-parse --show-toplevel`.cwd(record.directory).text()).trim()
      expect(path.resolve(topLevel)).toBe(path.resolve(record.directory))
    } finally {
      await fs.rm(ancestorGit, { recursive: true, force: true })
    }
  })

  test("rejects a conflicting reverse index instead of silently repairing it", async () => {
    const first = await ManagedProjectOwnership.ensure({ ...identity(crypto.randomUUID()), remoteState: "active" })
    const secondInput = identity(crypto.randomUUID())
    const second = await ManagedProjectOwnership.ensure({ ...secondInput, remoteState: "active" })
    await Storage.write(StoragePath.channelManagedOwnershipReverse(first.scopeID), secondInput)

    await expect(ManagedProjectOwnership.findByScopeID(first.scopeID)).rejects.toMatchObject({
      name: "ManagedProjectOwnershipMismatchError",
    })
    expect(await ManagedProjectOwnership.find(secondInput)).toEqual(second)
  })
  test("skips malformed forward records and raises a bounded diagnostic", async () => {
    const valid = await ManagedProjectOwnership.ensure({
      ...identity(crypto.randomUUID()),
      remoteState: "active",
    })
    const corruptHash = `corrupt-${crypto.randomUUID()}`
    await Storage.write(StoragePath.channelManagedOwnership(corruptHash), {
      channelType: "clarus",
      accountId: "missing-required-fields",
    })

    const records = await ManagedProjectOwnership.listAll()
    const issue = ObservabilityIssues.list({ module: "channel", limit: 1_000 }).find(
      (candidate) =>
        candidate.code === "CHANNEL_MANAGED_OWNERSHIP_RECORD_INVALID" &&
        candidate.evidence["recordHash"] === corruptHash,
    )

    expect(records).toContainEqual(valid)
    expect(issue).toBeDefined()
  })

  test("isolates the same external Project ID across accounts", async () => {
    const externalProjectId = `project-${crypto.randomUUID()}`
    const [first, second] = await Promise.all([
      ManagedProjectOwnership.ensure({
        channelType: "clarus",
        accountId: "agent-one",
        externalProjectId,
        remoteState: "active",
      }),
      ManagedProjectOwnership.ensure({
        channelType: "clarus",
        accountId: "agent-two",
        externalProjectId,
        remoteState: "active",
      }),
    ])

    expect(first.scopeID).not.toBe(second.scopeID)
    expect(first.directory).not.toBe(second.directory)
  })

  test("remote archive preserves Scope, files, Sessions, and ownership", async () => {
    const input = identity(crypto.randomUUID())
    const record = await ManagedProjectOwnership.ensure({ ...input, remoteState: "active" })
    const scope = await Scope.fromID(record.scopeID)
    if (scope?.type !== "project") throw new Error("Expected managed Project Scope")
    const marker = path.join(record.directory, "preserved.txt")
    await Bun.write(marker, "preserved")
    const session = await ScopeContext.provide({
      scope,
      fn: () => Session.create({ scope, title: "Preserved task history" }),
    })

    const archived = await ManagedProjectOwnership.markArchived(input)

    expect(archived.remoteState).toBe("archived")
    expect(await Scope.fromID(record.scopeID)).toMatchObject({ id: record.scopeID })
    expect(await Bun.file(marker).text()).toBe("preserved")
    expect(await Session.get(session.id)).toMatchObject({ id: session.id, scope: { id: record.scopeID } })
    expect(await ManagedProjectOwnership.findByScopeID(record.scopeID)).toEqual(archived)
  })

  test("re-discovery reuses archived ownership without overwriting local naming", async () => {
    const input = identity(crypto.randomUUID())
    const created = await ManagedProjectOwnership.ensure({
      ...input,
      projectName: "Initial remote name",
      remoteState: "active",
    })
    await Scope.updatePersisted({ scopeID: created.scopeID, name: "User name" })
    await ManagedProjectOwnership.markArchived(input)

    const restored = await ManagedProjectOwnership.ensure({
      ...input,
      projectName: "Changed remote name",
      remoteState: "active",
    })

    expect(restored.scopeID).toBe(created.scopeID)
    expect(restored.directory).toBe(created.directory)
    expect(restored.remoteState).toBe("active")
    const reResolved = (await Scope.fromID(created.scopeID)) as Scope.Project | undefined
    expect(reResolved?.name ?? null).toBe("User name")
  })

  test("uses hashed paths and rejects a symbolic-link workspace component", async () => {
    const suffix = crypto.randomUUID()
    const input = {
      channelType: "clarus",
      accountId: `../../agent-${suffix}`,
      externalProjectId: `../project-${suffix}`,
    }
    const hash = new Bun.CryptoHasher("sha256")
      .update(input.channelType)
      .update("\0")
      .update(input.accountId)
      .update("\0")
      .update(input.externalProjectId)
      .digest("hex")
    const target = path.join(Global.Path.data, "channel", `managed-target-${suffix}`)
    const link = path.join(Global.Path.data, "channel", "workspaces", hash)
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir")

    await expect(ManagedProjectOwnership.ensure({ ...input, remoteState: "active" })).rejects.toThrow("symbolic links")
    expect(String(await fs.realpath(link))).toBe(String(await fs.realpath(target)))
  })
})

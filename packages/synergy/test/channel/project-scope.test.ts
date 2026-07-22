import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Channel } from "../../src/channel"
import { Global } from "../../src/global"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"

function identity(label: string) {
  return {
    channelType: "test-channel",
    accountId: `account-${label}`,
    externalProjectId: `project-${label}`,
  }
}

function ownershipHash(input: { channelType: string; accountId: string; externalProjectId: string }) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input.channelType)
  hasher.update("\0")
  hasher.update(input.accountId)
  hasher.update("\0")
  hasher.update(input.externalProjectId)
  return hasher.digest("hex")
}

describe("Channel project ownership", () => {
  test("reuses one real project Scope for the same external project", async () => {
    const input = identity(crypto.randomUUID())

    const first = await Channel.ensureProjectScope({ ...input, projectName: "First name" })
    const second = await Channel.ensureProjectScope({ ...input, projectName: "Renamed project" })

    expect(first.type).toBe("project")
    expect(second.id).toBe(first.id)
    expect(second.directory).toBe(first.directory)
    expect(await Scope.fromID(first.id)).toMatchObject({ id: first.id })
    expect(await Channel.findProjectScope(input)).toMatchObject({ id: first.id })
  })

  test("separates identical project IDs across accounts and providers", async () => {
    const suffix = crypto.randomUUID()
    const externalProjectId = `project-${suffix}`

    const [first, second, third] = await Promise.all([
      Channel.ensureProjectScope({ channelType: "first", accountId: "one", externalProjectId }),
      Channel.ensureProjectScope({ channelType: "first", accountId: "two", externalProjectId }),
      Channel.ensureProjectScope({ channelType: "second", accountId: "one", externalProjectId }),
    ])

    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    expect(new Set([first.directory, second.directory, third.directory]).size).toBe(3)
  })

  test("serializes concurrent ensure calls", async () => {
    const input = identity(crypto.randomUUID())
    const scopes = await Promise.all(Array.from({ length: 8 }, () => Channel.ensureProjectScope(input)))

    expect(new Set(scopes.map((scope) => scope.id))).toEqual(new Set([scopes[0]!.id]))
  })

  test("archive preserves Scope, files, Sessions, and ownership", async () => {
    const input = identity(crypto.randomUUID())
    const created = await Channel.ensureProjectScope(input)
    const marker = path.join(created.directory, "preserved.txt")
    await Bun.write(marker, "preserved")
    const session = await ScopeContext.provide({
      scope: created,
      fn: () => Session.create({ scope: created, title: "Project history" }),
    })

    await Channel.archiveProjectScope(input)

    expect(await Scope.fromID(created.id)).toMatchObject({ id: created.id })
    expect(await Bun.file(marker).text()).toBe("preserved")
    expect(await Session.get(session.id)).toMatchObject({ id: session.id, scope: { id: created.id } })

    const ownershipRecord = await ManagedProjectOwnership.find({
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
    expect(ownershipRecord).toBeDefined()
    expect(ownershipRecord!.remoteState).toBe("archived")
  })

  test("rebuilds a missing forward record from the stable workspace", async () => {
    const input = identity(crypto.randomUUID())
    const created = await Channel.ensureProjectScope(input)
    const hash = ownershipHash({
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
    await Storage.remove(StoragePath.channelManagedOwnership(hash))

    const restored = await Channel.ensureProjectScope(input)

    expect(restored.id).toBe(created.id)
    expect(await Channel.findProjectScope(input)).toMatchObject({ id: created.id })
  })

  test("fails instead of rebinding a conflicting Scope identity", async () => {
    const input = identity(crypto.randomUUID())
    const created = await Channel.ensureProjectScope(input)
    const hash = ownershipHash({
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
    await Storage.write(StoragePath.channelManagedOwnership(hash), {
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
      scopeID: "scope_conflict",
      directory: created.directory,
      remoteState: "active",
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    })

    await expect(Channel.ensureProjectScope(input)).rejects.toMatchObject({
      name: "ManagedProjectOwnershipMismatchError",
    })
  })

  test("uses only the identity hash in paths and rejects symbolic-link components", async () => {
    const suffix = crypto.randomUUID()
    const input = {
      channelType: "test-channel",
      accountId: `../../account-${suffix}`,
      externalProjectId: `../project-${suffix}`,
    }
    const hash = ownershipHash({
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })
    const target = path.join(Global.Path.data, "channel", `symlink-target-${suffix}`)
    const linkDir = path.join(Global.Path.data, "channel", "workspaces", hash)
    await fs.mkdir(path.dirname(linkDir), { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, linkDir, process.platform === "win32" ? "junction" : "dir")

    let failure: unknown
    try {
      await Channel.ensureProjectScope(input)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("symbolic links")
    expect(String(failure)).not.toContain(input.accountId)
    expect(String(failure)).not.toContain(input.externalProjectId)
  })
})

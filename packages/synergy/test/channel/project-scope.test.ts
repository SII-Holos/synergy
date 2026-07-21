import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Channel } from "../../src/channel"
import { Global } from "../../src/global"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

function identity(label: string) {
  return {
    channelType: "test-channel",
    accountId: `account-${label}`,
    projectID: `project-${label}`,
  }
}

function identityHash(input: ReturnType<typeof identity>) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input.channelType)
  hasher.update("\0")
  hasher.update(input.accountId)
  hasher.update("\0")
  hasher.update(input.projectID)
  return hasher.digest("hex")
}

describe("Channel project scopes", () => {
  test("reuses one real project Scope for the same external project", async () => {
    const input = identity(crypto.randomUUID())

    const first = await Channel.ensureProjectScope({ ...input, projectName: "First name" })
    const second = await Channel.ensureProjectScope({ ...input, projectName: "Renamed project" })

    expect(first.type).toBe("project")
    expect(second.id).toBe(first.id)
    expect(second.directory).toBe(first.directory)
    expect(second.name).toBe("Renamed project")
    expect(await Scope.fromID(first.id)).toMatchObject({ id: first.id, name: "Renamed project" })
    expect(await Channel.findProjectScope(input)).toMatchObject({ id: first.id })
  })

  test("separates identical project IDs across accounts and providers", async () => {
    const suffix = crypto.randomUUID()
    const projectID = `project-${suffix}`

    const [first, second, third] = await Promise.all([
      Channel.ensureProjectScope({ channelType: "first", accountId: "one", projectID }),
      Channel.ensureProjectScope({ channelType: "first", accountId: "two", projectID }),
      Channel.ensureProjectScope({ channelType: "second", accountId: "one", projectID }),
    ])

    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    expect(new Set([first.directory, second.directory, third.directory]).size).toBe(3)
  })

  test("serializes concurrent ensure calls", async () => {
    const input = identity(crypto.randomUUID())
    const scopes = await Promise.all(Array.from({ length: 8 }, () => Channel.ensureProjectScope(input)))

    expect(new Set(scopes.map((scope) => scope.id))).toEqual(new Set([scopes[0]!.id]))
  })

  test("archives without deleting and reactivates the same Scope", async () => {
    const input = identity(crypto.randomUUID())
    const created = await Channel.ensureProjectScope(input)
    const session = await ScopeContext.provide({
      scope: created,
      fn: () => Session.create({ scope: created, title: "Project history" }),
    })
    const bindingKey = StoragePath.channelProjectScope(identityHash(input))

    await Channel.archiveProjectScope(input)

    expect(await Scope.fromID(created.id)).toBeUndefined()
    expect((await fs.stat(created.directory)).isDirectory()).toBe(true)
    expect(await Session.get(session.id)).toMatchObject({ id: session.id, scope: { id: created.id } })
    expect(await Storage.read<{ projectID: string; scopeID: string }>(bindingKey)).toEqual({
      projectID: input.projectID,
      scopeID: created.id,
    })

    const restored = await Channel.ensureProjectScope(input)
    expect(restored.id).toBe(created.id)
    expect(restored.directory).toBe(created.directory)
  })

  test("rebuilds a missing binding from the stable workspace", async () => {
    const input = identity(crypto.randomUUID())
    const created = await Channel.ensureProjectScope(input)
    await Storage.remove(StoragePath.channelProjectScope(identityHash(input)))

    const restored = await Channel.ensureProjectScope(input)

    expect(restored.id).toBe(created.id)
    expect(await Channel.findProjectScope(input)).toMatchObject({ id: created.id })
  })

  test("fails instead of rebinding a conflicting Scope identity", async () => {
    const input = identity(crypto.randomUUID())
    const created = await Channel.ensureProjectScope(input)
    await Storage.write(StoragePath.channelProjectScope(identityHash(input)), {
      projectID: input.projectID,
      scopeID: "scope_conflict",
    })

    await expect(Channel.ensureProjectScope(input)).rejects.toMatchObject({
      name: "ChannelProjectScopeConflictError",
      data: { expectedScopeID: "scope_conflict", actualScopeID: created.id },
    })
  })

  test("archive never follows a conflicting binding into another Scope", async () => {
    const first = identity(crypto.randomUUID())
    const second = identity(crypto.randomUUID())
    const expected = await Channel.ensureProjectScope(first)
    const unrelated = await Channel.ensureProjectScope(second)
    await Storage.write(StoragePath.channelProjectScope(identityHash(first)), {
      projectID: first.projectID,
      scopeID: unrelated.id,
    })

    await expect(Channel.archiveProjectScope(first)).rejects.toMatchObject({
      name: "ChannelProjectScopeConflictError",
      data: { expectedScopeID: unrelated.id, actualScopeID: expected.id },
    })
    expect(await Scope.fromID(unrelated.id)).toMatchObject({ id: unrelated.id })
  })

  test("uses only the identity hash in paths and rejects symbolic-link components", async () => {
    const suffix = crypto.randomUUID()
    const input = {
      channelType: "test-channel",
      accountId: `../../account-${suffix}`,
      projectID: `../project-${suffix}`,
    }
    const hash = identityHash(input)
    const target = path.join(Global.Path.data, "channel", `symlink-target-${suffix}`)
    const link = path.join(Global.Path.data, "channel", "workspaces", hash)
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir")

    let failure: unknown
    try {
      await Channel.ensureProjectScope(input)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("symbolic links")
    expect(String(failure)).not.toContain(input.accountId)
    expect(String(failure)).not.toContain(input.projectID)
  })
})

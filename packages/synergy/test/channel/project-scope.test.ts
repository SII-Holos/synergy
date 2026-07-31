import { describe, expect, mock, test } from "bun:test"
import { Channel } from "../../src/channel"
import { Config } from "../../src/config/config"
import type { Provider, StreamingSession } from "../../src/channel/types"
import type { ChannelHost } from "../../src/channel/host"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { ScopeRuntime } from "../../src/scope/runtime"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { tmpdir } from "../fixture/fixture"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"

describe("Channel account project scope", () => {
  test("accepts an optional Feishu project directory", () => {
    const account = Config.ChannelFeishuAccount.parse({
      appId: "app",
      appSecret: "secret",
      projectDir: "/projects/synergy",
    })

    expect(account.projectDir).toBe("/projects/synergy")
    expect(
      Config.ChannelFeishuAccount.parse({
        appId: "app",
        appSecret: "secret",
      }).projectDir,
    ).toBeUndefined()
  })

  test("resolves an explicit project directory to a project scope", async () => {
    await using tmp = await tmpdir({ git: true })

    const scope = await Channel.resolveAccountScope({
      channelType: "feishu",
      accountId: "synergy-dev",
      accountConfig: { projectDir: tmp.path },
    })

    expect(scope.type).toBe("project")
    expect(scope.directory).toBe(tmp.path)
  })

  test("rejects an explicit project directory that cannot resolve to a project", async () => {
    await using tmp = await tmpdir()
    const missing = `${tmp.path}/missing`

    await expect(
      Channel.resolveAccountScope({
        channelType: "feishu",
        accountId: "synergy-dev",
        accountConfig: { projectDir: missing },
      }),
    ).rejects.toThrow("CHANNEL_PROJECT_DIR_NOT_FOUND")
  })

  test("rejects a projectDir that is not a directory", async () => {
    await using tmp = await tmpdir()
    const file = `${tmp.path}/project.txt`
    await Bun.write(file, "not a project directory")

    await expect(
      Channel.resolveAccountScope({
        channelType: "feishu",
        accountId: "synergy-dev",
        accountConfig: { projectDir: file },
      }),
    ).rejects.toThrow("CHANNEL_PROJECT_DIR_NOT_READABLE")
  })

  test("keeps accounts without a project directory in the home scope", async () => {
    const scope = await Channel.resolveAccountScope({
      channelType: "feishu",
      accountId: "default",
      accountConfig: {},
    })

    expect(scope).toEqual(Scope.home())
  })

  test("routes provider conversation ingress through the resolved account Scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const type = `project-scope-${crypto.randomUUID()}`
    const accountId = "project-account"
    const chatId = "project-chat"
    const endpoint = SessionEndpoint.fromChannel({ type, accountId, chatId })
    await ScopeContext.provide({
      scope,
      fn: () => Session.create({ scope, endpoint }),
    })

    let host: ChannelHost.Instance | undefined
    const replies: string[] = []
    const streaming = (): StreamingSession => ({
      async start() {},
      async update() {},
      async updateToolProgress() {},
      async close() {},
      isActive: () => false,
    })
    const provider = {
      type,
      lifecycle: "self_connected" as const,
      conversation: {
        async replyMessage(input) {
          replies.push(
            input.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          )
          return { messageId: "reply" }
        },
        async pushMessage() {
          return { messageId: "push" }
        },
        async addReaction() {},
        createStreamingSession: streaming,
      },
      async connect(input: Parameters<Provider["connect"]>[0]) {
        host = input.host
      },
    } satisfies Provider
    Channel.registerProvider(provider)

    const originalConfigCurrent = Config.current
    Config.current = mock(async () => {
      return {
        channel: {
          [type]: {
            type,
            accounts: { [accountId]: { enabled: true, projectDir: tmp.path } },
          },
        },
      } as unknown as Config.Info
    }) as typeof Config.current

    try {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await Channel.reload()
          await Channel.init()
        },
      })
      const timeoutAt = Date.now() + 2_000
      while (!host && Date.now() < timeoutAt) await Bun.sleep(5)
      expect(host).toBeDefined()
      await host!.conversations.receive({
        chatId,
        chatType: "dm",
        senderId: "sender",
        text: "/status",
        messageId: "message",
        timestamp: Date.now(),
      })

      expect(replies).toHaveLength(1)
      expect(replies[0]).toContain("Messages: 0")
    } finally {
      Config.current = originalConfigCurrent
      await ScopeContext.provide({ scope: Scope.home(), fn: () => Channel.stopAll() })
    }
  })
  test("delivers recovered pending channel output while the resolved account Scope runtime restarts", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const type = `project-outbound-${crypto.randomUUID()}`
    const accountId = "project-account"
    const chatId = "project-chat"
    const replies: string[] = []
    let connected = false

    const provider = {
      type,
      lifecycle: "self_connected" as const,
      conversation: {
        async replyMessage(input) {
          replies.push(input.messageId)
          return { messageId: "reply" }
        },
        async pushMessage() {
          return { messageId: "push" }
        },
        async addReaction() {},
        createStreamingSession: () => ({
          async start() {},
          async update() {},
          async updateToolProgress() {},
          async close() {},
          isActive: () => false,
        }),
      },
      async connect() {
        connected = true
      },
    } satisfies Provider
    Channel.registerProvider(provider)

    const originalConfigCurrent = Config.current
    Config.current = mock(async () => {
      return {
        channel: {
          [type]: {
            type,
            accounts: { [accountId]: { enabled: true, projectDir: tmp.path } },
          },
        },
      } as unknown as Config.Info
    }) as typeof Config.current

    try {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await Channel.reload()
          await Channel.init()
        },
      })
      const connectionDeadline = Date.now() + 2_000
      while (!connected && Date.now() < connectionDeadline) await Bun.sleep(5)
      expect(connected).toBe(true)

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({
            scope,
            endpoint: SessionEndpoint.fromChannel({ type, accountId, chatId }),
          })
          const rootID = Identifier.ascending("message")
          await Session.updateMessage({
            id: rootID,
            role: "user",
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
            isRoot: true,
            rootID,
            sessionID: session.id,
          })
          const assistant = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: rootID,
            rootID,
            mode: "synergy",
            agent: "synergy",
            path: { cwd: scope.directory, root: scope.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test-model",
            providerID: "test-provider",
            time: { created: Date.now() },
            sessionID: session.id,
            metadata: {
              channelPush: true,
              channelReply: true,
              channelReplyToMessageId: "message-topic-root",
            },
          } as MessageV2.Assistant)) as MessageV2.Assistant
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "Interrupted background work",
          })
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })
        },
      })

      await ScopeRuntime.dispose(scope.id)
      await ScopeRuntime.ensure(scope)

      const deliveryDeadline = Date.now() + 1_000
      while (replies.length === 0 && Date.now() < deliveryDeadline) await Bun.sleep(5)
      expect(replies).toEqual(["message-topic-root"])
    } finally {
      Config.current = originalConfigCurrent
      await ScopeContext.provide({ scope: Scope.home(), fn: () => Channel.stopAll() })
      await ScopeRuntime.dispose(scope.id)
    }
  })
})

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

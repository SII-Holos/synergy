import { describe, expect, test } from "bun:test"
import * as ChannelTypes from "../../src/channel/types"
import { SessionEndpoint } from "../../src/session/endpoint"

describe("Channel target identity", () => {
  test("preserves the existing Feishu chat endpoint key byte-for-byte", () => {
    const legacy = SessionEndpoint.fromChannel({
      type: "feishu",
      accountId: "account",
      chatId: "chat",
    })
    const targeted = SessionEndpoint.fromChannel({
      type: "feishu",
      accountId: "account",
      target: { kind: "chat", chatId: "chat" },
    })

    expect(SessionEndpoint.toKey(legacy)).toBe("channel:feishu:account:chat:chat")
    expect(SessionEndpoint.toKey(targeted)).toBe(SessionEndpoint.toKey(legacy))
  })

  test("keys chat, project, and task targets deterministically without collisions", () => {
    const identities = [
      ChannelTypes.toKey({
        type: "clarus",
        accountId: "agent",
        target: { kind: "chat", chatId: "project/task" },
      }),
      ChannelTypes.toKey({
        type: "clarus",
        accountId: "agent",
        target: { kind: "project", externalProjectId: "project/task" },
      }),
      ChannelTypes.toKey({
        type: "clarus",
        accountId: "agent",
        target: { kind: "task", externalProjectId: "project", externalTaskId: "task" },
      }),
    ]

    expect(identities).toEqual([
      "clarus:agent:chat:project/task",
      "clarus:agent:project:project/task",
      "clarus:agent:project:project:task:task",
    ])
    expect(new Set(identities).size).toBe(identities.length)
  })

  test("task identity excludes run and local ownership state", () => {
    const target = {
      type: "clarus",
      accountId: "agent",
      target: { kind: "task" as const, externalProjectId: "project", externalTaskId: "task" },
    }

    expect(ChannelTypes.toKey(target)).toBe("clarus:agent:project:project:task:task")
  })
  test("rejects missing or conflicting endpoint identity", () => {
    expect(ChannelTypes.Info.safeParse({ type: "clarus", accountId: "agent" }).success).toBe(false)
    expect(
      ChannelTypes.Info.safeParse({
        type: "clarus",
        accountId: "agent",
        chatId: "legacy-chat",
        target: { kind: "task", externalProjectId: "project", externalTaskId: "task" },
      }).success,
    ).toBe(false)
  })
})

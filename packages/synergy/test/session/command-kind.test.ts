import { describe, expect, test } from "bun:test"
import { Command } from "../../src/command/command"
import { Instance } from "../../src/scope/instance"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { MessageV2 } from "../../src/session/message-v2"
import { Turn } from "../../src/session/turn"
import { tmpdir } from "../fixture/fixture"

function userMessage(id: string, text: string, metadata?: Record<string, unknown>): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "user",
      time: { created: Date.now() },
      agent: "synergy",
      model: { providerID: "system", modelID: "test" },
      metadata,
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID: "ses_test",
        messageID: id,
        type: "text",
        text,
      },
    ],
  }
}

function assistantMessage(
  id: string,
  parentID: string,
  text: string,
  metadata?: Record<string, unknown>,
): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_test",
      role: "assistant",
      parentID,
      time: { created: Date.now(), completed: Date.now() },
      mode: "synergy",
      agent: "synergy",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "system",
      finish: "stop",
      metadata,
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID: "ses_test",
        messageID: id,
        type: "text",
        text,
      },
    ],
  }
}

describe("command kind architecture", () => {
  test("built-in worktree is an action command and prompt commands stay prompt-visible", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await Instance.provide({
      scope,
      fn: async () => {
        const worktree = await Command.get(Command.Default.WORKTREE)
        const review = await Command.get(Command.Default.REVIEW)

        expect(worktree?.kind).toBe("action")
        expect(worktree?.action).toBe("worktree")
        expect(worktree?.promptVisible).toBe(false)
        expect(worktree?.surfaces).toContain("web")

        expect(review?.kind).toBe("prompt")
        expect(review?.promptVisible).toBe(true)
        expect(review?.template).toBeString()
      },
    })
  })

  test("action handlers are registered through the command action registry", async () => {
    const result = await Command.runAction({
      action: "test.echo",
      input: { sessionID: "ses_test", command: "test", arguments: "hello" },
    }).catch((error) => error)
    expect(result).toBeInstanceOf(Error)

    const unregister = Command.registerAction("test.echo", async (input) => ({
      title: "Echo",
      output: input.arguments,
    }))
    try {
      const executed = await Command.runAction({
        action: "test.echo",
        input: { sessionID: "ses_test", command: "test", arguments: "hello" },
      })
      expect(executed.output).toBe("hello")
    } finally {
      unregister()
    }
  })

  test("non-prompt-visible command records are excluded from model prompt history", () => {
    const messages: MessageV2.WithParts[] = [
      userMessage("msg_visible_user", "real question"),
      assistantMessage("msg_visible_assistant", "msg_visible_user", "real answer"),
      userMessage("msg_command_user", "/worktree list", {
        command: { name: "worktree", kind: "action", promptVisible: false },
      }),
      assistantMessage("msg_command_assistant", "msg_command_user", "worktree list result", {
        command: { name: "worktree", kind: "action", promptVisible: false },
      }),
    ]

    const modelMessages = MessageV2.toModelMessage(messages) as Array<{ role: string; content: string }>
    const text = JSON.stringify(modelMessages)
    expect(text).toContain("real question")
    expect(text).toContain("real answer")
    expect(text).not.toContain("/worktree list")
    expect(text).not.toContain("worktree list result")
  })

  test("action command records are semantic-synthetic turns", () => {
    const messages: MessageV2.WithParts[] = [
      userMessage("msg_command_user", "/worktree list", {
        promptVisible: false,
        command: { name: "worktree", kind: "action", promptVisible: false },
      }),
      assistantMessage("msg_command_assistant", "msg_command_user", "worktree list result", {
        promptVisible: false,
        command: { name: "worktree", kind: "action", promptVisible: false },
      }),
      userMessage("msg_real_user", "real question"),
    ]

    expect(Turn.isSyntheticUser(messages[0])).toBe(true)
    expect(Turn.isSyntheticUser(messages[2])).toBe(false)
    expect(Turn.collect(messages, { skipSynthetic: true })).toHaveLength(1)
    expect(Turn.countRecentTurns(messages, 1)).toBe(2)
  })

  test("action commands write visible command records without entering model prompt history", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await Instance.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Command Action" })
        await SessionInvoke.command({
          sessionID: session.id,
          command: Command.Default.WORKTREE,
          arguments: "list",
        })

        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(2)
        expect(messages[0].info.role).toBe("user")
        expect(messages[1].info.role).toBe("assistant")
        expect(messages[0].parts[0]).toMatchObject({ type: "text", text: "/worktree list" })
        expect(messages[1].parts[0]).toMatchObject({ type: "text" })
        expect((messages[0].info.metadata as any)?.promptVisible).toBe(false)
        expect((messages[1].info.metadata as any)?.promptVisible).toBe(false)

        const modelMessages = MessageV2.toModelMessage(messages) as Array<{ role: string; content: string }>
        expect(JSON.stringify(modelMessages)).not.toContain("/worktree list")
      },
    })
  })
})

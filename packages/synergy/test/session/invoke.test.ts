import { describe, expect, test, mock } from "bun:test"
import { SessionManager } from "../../src/session/manager"
import { SessionInvoke } from "../../src/session/invoke"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionInbox } from "../../src/session/inbox"
import { SessionProgress } from "../../src/session/progress"
import { PermissionNext } from "../../src/permission/next"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { ToolResolver } from "../../src/session/tool-resolver"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { SessionProcessor } from "../../src/session/processor"
import { Identifier } from "../../src/id/id"
import { Cortex } from "../../src/cortex/manager"
import { Embedding } from "../../src/vector/embedding"
import { Worktree } from "../../src/project/worktree"

const sessionID = "ses_test"

function userMessage(id: string, noReply?: boolean): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "synergy",
      model: { providerID: "test", modelID: "test" },
      metadata: noReply ? { noReply: true } : undefined,
    } as MessageV2.User,
    parts: [],
  }
}

function assistantMessage(id: string, parentID: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 0, completed: 0 },
      parentID,
      modelID: "test-model",
      providerID: "test-provider",
      mode: "test",
      agent: "test",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    } as MessageV2.Assistant,
    parts: [
      {
        id: `prt_${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      } as MessageV2.TextPart,
    ],
  }
}

function installBasicLoopMocks(options?: {
  onBuildPlan?: (input: any) => void
  onProcess?: (input: any, assistant: MessageV2.Assistant, callIndex: number) => Promise<void> | void
  config?: Record<string, unknown>
}) {
  const originalGetModel = Provider.getModel
  const originalGetAgent = Agent.get
  const originalConfigCurrent = Config.current
  const originalDefinitions = ToolResolver.definitions
  const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
  const originalBuildPlan = PromptBudgeter.buildPlan
  const originalDecide = PromptBudgeter.decide
  const originalProcessorCreate = SessionProcessor.create
  const originalCortexList = Cortex.list
  const originalCortexGetRunningTasks = Cortex.getRunningTasks
  const originalEmbeddingGenerate = Embedding.generate

  let callIndex = 0

  ;(Provider.getModel as any) = mock(async () => ({
    id: "test-model",
    providerID: "test-provider",
    name: "Test Model",
    limit: { context: 100_000, output: 8_192 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai" },
    options: {},
  }))
  ;(Agent.get as any) = mock(async (name: string) => ({
    name,
    mode: "primary",
    permission: PermissionNext.fromConfig({ "*": "allow" }),
    options: {},
  }))
  ;(Config.current as any) = mock(async () => ({
    ...(await originalConfigCurrent()),
    compaction: { auto: true, maxHistoryImages: 8 },
    library: { memory: { enabled: false }, experience: { retrieve: false } },
    ...options?.config,
  }))
  ;(ToolResolver.definitions as any) = mock(async () => [])
  ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({ tools: {}, activeToolIDs: [] }))
  ;(PromptBudgeter.buildPlan as any) = mock(async (input: Parameters<typeof PromptBudgeter.buildPlan>[0]) => {
    options?.onBuildPlan?.(input)
    return {
      system: input.system,
      systemCacheBreakpoint: input.systemCacheBreakpoint,
      lateSystem: input.lateSystem,
      messages: input.messages,
      toolDefinitions: input.toolDefinitions,
    }
  })
  ;(PromptBudgeter.decide as any) = mock(async () => ({
    budget: { context: 100_000, usable: 100_000, threshold: 0.85, soft: 85_000 },
    measure: { system: 10, messages: 10, tools: 0, total: 20 },
    shouldCompact: false,
  }))
  ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
    message: input.assistantMessage,
    partFromToolCall: () => undefined,
    trackExecution: () => {},
    process: mock(async (processInput: any) => {
      callIndex++
      await options?.onProcess?.(processInput, input.assistantMessage, callIndex)
      input.assistantMessage.finish = "stop"
      input.assistantMessage.time.completed = Date.now()
      await Session.updateMessage(input.assistantMessage)
      return "stop" as const
    }),
  }))
  ;(Cortex.list as any) = mock(() => [])
  ;(Cortex.getRunningTasks as any) = mock(() => [])
  ;(Embedding.generate as any) = mock(async (input: Parameters<typeof Embedding.generate>[0]) => ({
    id: input.id,
    vector: [],
    model: "test-embedding",
  }))

  return () => {
    ;(Provider.getModel as any) = originalGetModel
    ;(Agent.get as any) = originalGetAgent
    ;(Config.current as any) = originalConfigCurrent
    ;(ToolResolver.definitions as any) = originalDefinitions
    ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
    ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
    ;(PromptBudgeter.decide as any) = originalDecide
    ;(SessionProcessor.create as any) = originalProcessorCreate
    ;(Cortex.list as any) = originalCortexList
    ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
    ;(Embedding.generate as any) = originalEmbeddingGenerate
  }
}

async function createSessionWithUser(options?: { silent?: boolean }) {
  const session = await Session.create({
    completionNotice: options?.silent ? { silent: true } : undefined,
  })
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: session.id,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID: session.id,
    type: "text",
    text: "Run the session",
  })
  return { session, user }
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

async function createWorktreeSessionWithUser(name: string) {
  const session = await Session.create({})
  const worktree = await Worktree.create({
    sessionID: session.id,
    name,
    baseRef: "current",
    bind: true,
  })
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: session.id,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID: session.id,
    type: "text",
    text: "Run in the active worktree",
  })
  return { session, worktree, user }
}

async function removeWorktreeSession(sessionID: string, worktreeID: string | undefined) {
  if (worktreeID) {
    await Worktree.remove({ sessionID, target: worktreeID, force: true }).catch(() => undefined)
  }
  await Session.remove(sessionID).catch(() => undefined)
}

describe("SessionInvoke workspace execution context", () => {
  test("direct loop restores the persisted worktree workspace without ambient scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    let sessionID = ""
    let worktreeID: string | undefined
    let worktreePath = ""
    let assistantPath: MessageV2.Assistant["path"] | undefined
    let systemPrompt = ""
    const restore = installBasicLoopMocks({
      onProcess: async (input, assistant) => {
        assistantPath = assistant.path
        systemPrompt = input.system.join("\n")
      },
    })

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const created = await createWorktreeSessionWithUser("loop-context")
          sessionID = created.session.id
          worktreeID = created.worktree.id
          worktreePath = created.worktree.path
        },
      })

      await SessionInvoke.loop.force(sessionID)

      expect(assistantPath).toEqual({ cwd: worktreePath, root: worktreePath })
      expect(systemPrompt).toContain(`Working directory: ${worktreePath}`)
      expect(systemPrompt).toContain(`Workspace path: ${worktreePath}`)
      expect(systemPrompt).toContain(`Original checkout: ${tmp.path}`)
    } finally {
      restore()
      SessionManager.unregisterRuntime(sessionID)
      if (sessionID) {
        await ScopeContext.provide({
          scope,
          fn: () => removeWorktreeSession(sessionID, worktreeID),
        })
      }
    }
  })

  test("asynchronous delivery wakes an idle worktree session inside the worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    let sessionID = ""
    let worktreeID: string | undefined
    let worktreePath = ""
    let assistantPath: MessageV2.Assistant["path"] | undefined
    const processed = Promise.withResolvers<void>()
    const restore = installBasicLoopMocks({
      onProcess: async (_input, assistant) => {
        assistantPath = assistant.path
        processed.resolve()
      },
    })

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({})
          const worktree = await Worktree.create({
            sessionID: session.id,
            name: "delivery-context",
            baseRef: "current",
            bind: true,
          })
          sessionID = session.id
          worktreeID = worktree.id
          worktreePath = worktree.path
        },
      })

      await SessionManager.deliver({
        target: sessionID,
        waitForProcessing: false,
        mail: {
          type: "user",
          agent: "synergy",
          model: { providerID: "test-provider", modelID: "test-model" },
          metadata: { source: "blueprint" },
          parts: [
            {
              id: Identifier.ascending("part"),
              sessionID,
              messageID: Identifier.ascending("message"),
              type: "text",
              text: "Continue from Blueprint",
            },
          ],
        },
      })

      await withTimeout(processed.promise, "worktree delivery wake")

      expect(assistantPath).toEqual({ cwd: worktreePath, root: worktreePath })
    } finally {
      restore()
      SessionManager.unregisterRuntime(sessionID)
      if (sessionID) {
        await ScopeContext.provide({
          scope,
          fn: () => removeWorktreeSession(sessionID, worktreeID),
        })
      }
    }
  })

  test("release-scheduled wake re-enters the worktree workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    let sessionID = ""
    let worktreeID: string | undefined
    let worktreePath = ""
    let assistantPath: MessageV2.Assistant["path"] | undefined
    const processed = Promise.withResolvers<void>()
    const restore = installBasicLoopMocks({
      onProcess: async (_input, assistant) => {
        assistantPath = assistant.path
        processed.resolve()
      },
    })

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({})
          const worktree = await Worktree.create({
            sessionID: session.id,
            name: "release-context",
            baseRef: "current",
            bind: true,
          })
          sessionID = session.id
          worktreeID = worktree.id
          worktreePath = worktree.path
          await SessionInbox.enqueueMail({
            sessionID,
            mail: {
              type: "user",
              agent: "synergy",
              model: { providerID: "test-provider", modelID: "test-model" },
              parts: [
                {
                  id: Identifier.ascending("part"),
                  sessionID,
                  messageID: Identifier.ascending("message"),
                  type: "text",
                  text: "Queued at release",
                },
              ],
            },
          })
        },
      })

      SessionManager.registerRuntime(sessionID)
      SessionManager.acquire(sessionID)
      await SessionManager.release(sessionID)
      await withTimeout(processed.promise, "release wake")

      expect(assistantPath).toEqual({ cwd: worktreePath, root: worktreePath })
    } finally {
      restore()
      SessionManager.unregisterRuntime(sessionID)
      if (sessionID) {
        await ScopeContext.provide({
          scope,
          fn: () => removeWorktreeSession(sessionID, worktreeID),
        })
      }
    }
  })
})

describe("SessionInvoke.selectResultMessage", () => {
  test("selects the last assistant for the latest reply-required user turn", () => {
    const user = userMessage("msg_user")
    const earlyAssistant = assistantMessage("msg_assistant_1", "msg_user", "early")
    const finalAssistant = assistantMessage("msg_assistant_2", "msg_user", "final")

    const result = SessionInvoke.selectResultMessage([user, earlyAssistant, finalAssistant])

    expect(result?.info.id).toBe("msg_assistant_2")
  })

  test("ignores assistant messages from earlier user turns", () => {
    const oldUser = userMessage("msg_old_user")
    const oldAssistant = assistantMessage("msg_old_assistant", "msg_old_user", "old final")
    const newUser = userMessage("msg_new_user")
    const newAssistant = assistantMessage("msg_new_assistant", "msg_new_user", "new final")

    const result = SessionInvoke.selectResultMessage([oldUser, oldAssistant, newUser, newAssistant])

    expect(result?.info.id).toBe("msg_new_assistant")
  })

  test("falls back to the latest assistant when there is no reply-required user", () => {
    const user = userMessage("msg_user", true)
    const assistant = assistantMessage("msg_assistant", "msg_user", "final")

    const result = SessionInvoke.selectResultMessage([user, assistant])

    expect(result?.info.id).toBe("msg_assistant")
  })
})

describe("SessionProgress.pendingReply", () => {
  test("uses assistant parent links instead of message id ordering", () => {
    const oldUser = userMessage("msg_user_1")
    const queuedUser = userMessage("msg_user_2")
    const unrelatedLaterAssistant = assistantMessage("msg_user_3", "msg_user_1", "old reply")

    // Key scenario: the reverse scan finds msg_user_3 (assistant, parentID=msg_user_1),
    // then msg_user_2 (user, no reply). Old id < id logic would see
    // lastTerminalAssistant.id (msg_user_3) > lastReplyRequiredUser.id (msg_user_2)
    // and incorrectly conclude a reply exists. ParentID check correctly returns true.
    expect(SessionProgress.pendingReply([oldUser, queuedUser, unrelatedLaterAssistant])).toBe(true)
  })

  test("materialized user with larger messageID than old assistant has no false reply", () => {
    // After queued input is materialized, its messageID is generated later and
    // is therefore alphabetically larger than the old assistant's messageID.
    // Old code using id < id ordering would see oldAssistant.id < queuedUser.id
    // and incorrectly conclude a reply exists (return false).
    //
    // Messages in reverse scan order:
    //   msg_3 (queuedUser) → lastReplyRequiredUser
    //   msg_2 (oldAssistant, parentID=msg_1) → lastTerminalAssistant
    //   msg_1 (oldUser)
    //
    // Old logic: lastTerminalAssistant.id (msg_2) < lastReplyRequiredUser.id (msg_3)
    // → returns false (no pending reply) ← WRONG
    //
    // New logic: hasTerminalReply(userID=msg_3) → no assistant with parentID=msg_3
    // → returns true (has pending reply) ← CORRECT
    const oldUser = userMessage("msg_1")
    const oldAssistant = assistantMessage("msg_2", "msg_1", "reply to old user")
    const queuedUser = userMessage("msg_3")

    expect(SessionProgress.pendingReply([oldUser, oldAssistant, queuedUser])).toBe(true)
  })
})

describe("SessionProgress.needsModelCall", () => {
  test("terminal root reply covers the latest non-root user injection", () => {
    const root = userMessage("msg_1") as MessageV2.WithParts & { info: MessageV2.User }
    root.info.isRoot = true
    root.info.rootID = root.info.id

    const steer = userMessage("msg_2") as MessageV2.WithParts & { info: MessageV2.User }
    steer.info.isRoot = false
    steer.info.rootID = root.info.id

    const reply = assistantMessage("msg_3", root.info.id, "covered steer") as MessageV2.WithParts & {
      info: MessageV2.Assistant
    }
    reply.info.rootID = root.info.id

    expect(SessionProgress.needsModelCall([root, steer], root.info.id)).toBe(true)
    expect(SessionProgress.needsModelCall([root, steer, reply], root.info.id)).toBe(false)
  })
})

describe("SessionInvoke system prompt assembly", () => {
  test("injects the git coauthor reminder into model system prompts", async () => {
    await using tmp = await tmpdir({ git: true })

    const originalGetModel = Provider.getModel
    const originalGetAgent = Agent.get
    const originalConfigCurrent = Config.current
    const originalDefinitions = ToolResolver.definitions
    const originalResolveWithAvailability = ToolResolver.resolveWithAvailability
    const originalBuildPlan = PromptBudgeter.buildPlan
    const originalDecide = PromptBudgeter.decide
    const originalProcessorCreate = SessionProcessor.create
    const originalCortexList = Cortex.list
    const originalCortexGetRunningTasks = Cortex.getRunningTasks
    const originalEmbeddingGenerate = Embedding.generate

    let capturedSystem: string[] | undefined
    let capturedLateSystem: string[] | undefined

    try {
      ;(Provider.getModel as any) = mock(async () => ({
        id: "test-model",
        providerID: "test-provider",
        name: "Test Model",
        limit: { context: 100_000, output: 8_192 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: false,
          temperature: true,
          input: { text: true, image: false, audio: false, video: false },
          output: { text: true, image: false, audio: false, video: false },
        },
        api: { npm: "@ai-sdk/openai" },
        options: {},
      }))
      ;(Agent.get as any) = mock(async () => ({
        name: "synergy",
        mode: "primary",
        permission: PermissionNext.fromConfig({ "*": "allow" }),
        options: {},
      }))
      ;(Config.current as any) = mock(async () => ({
        ...(await originalConfigCurrent()),
        compaction: { auto: true, maxHistoryImages: 8 },
        library: { memory: { enabled: false }, experience: { retrieve: false } },
      }))
      ;(ToolResolver.definitions as any) = mock(async () => [])
      ;(ToolResolver.resolveWithAvailability as any) = mock(async () => ({ tools: {}, activeToolIDs: [] }))
      ;(PromptBudgeter.buildPlan as any) = mock(async (input: Parameters<typeof PromptBudgeter.buildPlan>[0]) => {
        capturedSystem = input.system
        capturedLateSystem = input.lateSystem
        return {
          system: input.system,
          systemCacheBreakpoint: input.systemCacheBreakpoint,
          lateSystem: input.lateSystem,
          messages: [{ role: "user", content: "stub message" }],
          toolDefinitions: [],
        }
      })
      ;(PromptBudgeter.decide as any) = mock(async () => ({
        budget: { context: 100_000, usable: 100_000, threshold: 0.85, soft: 85_000 },
        measure: { system: 10, messages: 10, tools: 0, total: 20 },
        shouldCompact: false,
      }))
      ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
        message: input.assistantMessage,
        partFromToolCall: () => undefined,
        trackExecution: () => {},
        process: mock(async () => "stop" as const),
      }))
      ;(Cortex.list as any) = mock(() => [])
      ;(Cortex.getRunningTasks as any) = mock(() => [])
      ;(Embedding.generate as any) = mock(async (input: Parameters<typeof Embedding.generate>[0]) => ({
        id: input.id,
        vector: [],
        model: "test-embedding",
      }))

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const promptSessionID = session.id

          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: promptSessionID,
            agent: "synergy",
            model: {
              providerID: "test-provider",
              modelID: "test-model",
            },
            time: {
              created: Date.now(),
            },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: promptSessionID,
            type: "text",
            text: "Please commit the changes.",
          })

          await SessionInvoke.loop.force(promptSessionID)

          const systemPrompt = capturedSystem?.join("\n") ?? ""
          const lateSystemPrompt = capturedLateSystem?.join("\n") ?? ""
          expect(systemPrompt).not.toContain("<coauthor-reminder>")
          expect(lateSystemPrompt).toContain("<coauthor-reminder>")
          expect(lateSystemPrompt).toContain(
            "Co-authored-by: synergy-agent <299070056+synergy-agent@users.noreply.github.com>",
          )
          expect(lateSystemPrompt).toContain("</coauthor-reminder>")
        },
      })
    } finally {
      ;(Provider.getModel as any) = originalGetModel
      ;(Agent.get as any) = originalGetAgent
      ;(Config.current as any) = originalConfigCurrent
      ;(ToolResolver.definitions as any) = originalDefinitions
      ;(ToolResolver.resolveWithAvailability as any) = originalResolveWithAvailability
      ;(PromptBudgeter.buildPlan as any) = originalBuildPlan
      ;(PromptBudgeter.decide as any) = originalDecide
      ;(SessionProcessor.create as any) = originalProcessorCreate
      ;(Cortex.list as any) = originalCortexList
      ;(Cortex.getRunningTasks as any) = originalCortexGetRunningTasks
      ;(Embedding.generate as any) = originalEmbeddingGenerate
    }
  })
})

describe("SessionInvoke pre-stream error handling", () => {
  test("persists tool resolution failures as terminal assistant errors", async () => {
    await using tmp = await tmpdir({ git: true })

    const restore = installBasicLoopMocks()
    const processCalled = mock(async () => "stop" as const)
    ;(ToolResolver.definitions as any) = mock(async () => {
      throw new Error("plugin tool uses incompatible schema")
    })
    ;(SessionProcessor.create as any) = mock((input: Parameters<typeof SessionProcessor.create>[0]) => ({
      message: input.assistantMessage,
      partFromToolCall: () => undefined,
      trackExecution: () => {},
      process: processCalled,
    }))

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser()
          await Session.update(session.id, (draft) => {
            draft.pendingReply = true
          })

          await expect(SessionInvoke.loop.force(session.id)).rejects.toThrow("plugin tool uses incompatible schema")

          expect(processCalled).not.toHaveBeenCalled()
          const refreshed = await Session.get(session.id)
          expect(refreshed.pendingReply).toBeUndefined()

          const messages = await Session.messages({ sessionID: session.id })
          const assistants = messages.filter((message) => message.info.role === "assistant")
          expect(assistants).toHaveLength(1)

          const assistant = assistants[0]!.info as MessageV2.Assistant
          expect(assistant.finish).toBe("error")
          expect(assistant.time.completed).toBeNumber()
          expect(String((assistant.error?.data as { message?: unknown } | undefined)?.message)).toContain(
            "plugin tool uses incompatible schema",
          )
          expect(SessionProgress.pendingReply(messages)).toBe(false)
        },
      })
    } finally {
      restore()
    }
  })
})

describe("SessionInvoke inbox boundaries", () => {
  test("context inbox items are not materialized without a confirmed model call", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const root = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test-provider", modelID: "test-model" },
          isRoot: true,
          rootID: "",
          time: { created: Date.now() },
        })) as MessageV2.User
        root.rootID = root.id
        await Session.updateMessage(root)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: root.id,
          sessionID: session.id,
          type: "text",
          text: "already answered",
        })
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: root.id,
          rootID: root.id,
          mode: "synergy",
          agent: "synergy",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test-model",
          providerID: "test-provider",
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })

        await SessionInbox.deliver({
          sessionID: session.id,
          mode: "context",
          message: {
            role: "user",
            parts: [{ type: "text", text: "piggyback later" }],
            origin: { type: "user" },
          },
        })

        await SessionInvoke.loop.force(session.id)

        expect(await SessionInbox.list(session.id)).toHaveLength(1)
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages.map((msg) => MessageV2.extractText(msg.parts)).join("\n")).not.toContain("piggyback later")

        SessionManager.unregisterRuntime(session.id)
      },
    })
  })

  test("queued user input waits for after-turn and receives a materialization-time message id", async () => {
    await using tmp = await tmpdir({ git: true })

    let activeSessionID = ""
    let staleMessageID = ""
    const processedUsers: string[] = []
    const promptPayloads: string[] = []

    const restore = installBasicLoopMocks({
      onProcess: async (input, _assistant, callIndex) => {
        processedUsers.push(input.user.id)
        promptPayloads.push(JSON.stringify(input.messages))
        if (callIndex !== 1) return
        await SessionInbox.enqueueUser({
          sessionID: activeSessionID,
          messageID: staleMessageID,
          parts: [{ type: "text", text: "queued while running" }],
        })
      },
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          activeSessionID = session.id
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "initial prompt",
          })
          staleMessageID = Identifier.ascending("message")

          await SessionInvoke.loop.force(session.id)

          const messages = await Session.messages({ sessionID: session.id })
          const queued = messages.find(
            (msg): msg is MessageV2.WithParts & { info: MessageV2.User } =>
              msg.info.role === "user" && MessageV2.extractText(msg.parts).includes("queued while running"),
          )
          const firstReply = messages.find(
            (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } =>
              msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).parentID === user.id,
          )

          expect(processedUsers).toHaveLength(2)
          expect(processedUsers[0]).toBe(user.id)
          expect(queued).toBeDefined()
          expect(firstReply).toBeDefined()
          expect(processedUsers[1]).toBe(queued!.info.id)
          expect(queued!.info.id).not.toBe(staleMessageID)
          expect(queued!.info.id > firstReply!.info.id).toBe(true)
          expect(queued!.info.agent).toBe("synergy")
          expect(queued!.info.model).toEqual({ providerID: "test-provider", modelID: "test-model" })
          expect(promptPayloads[0]).not.toContain("queued while running")
          expect(promptPayloads[1]).toContain("queued while running")
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })

  test("guided inbox input steers the next model call without scheduling another turn", async () => {
    await using tmp = await tmpdir({ git: true })

    let activeSessionID = ""
    const processedUsers: string[] = []
    const promptPayloads: string[] = []

    const restore = installBasicLoopMocks({
      onProcess: (input) => {
        processedUsers.push(input.user.id)
        promptPayloads.push(JSON.stringify(input.messages))
      },
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          activeSessionID = session.id
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "user",
            sessionID: session.id,
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "initial prompt",
          })
          const staleMessageID = Identifier.ascending("message")
          const queued = await SessionInbox.enqueueUser({
            sessionID: session.id,
            agent: "synergy",
            model: { providerID: "test-provider", modelID: "test-model" },
            messageID: staleMessageID,
            parts: [{ type: "text", text: "steer sooner" }],
          })
          await SessionInbox.guide({ sessionID: session.id, itemID: queued.id })

          await SessionInvoke.loop.force(session.id)

          const messages = await Session.messages({ sessionID: session.id })
          const guided = messages.find(
            (msg): msg is MessageV2.WithParts & { info: MessageV2.User } =>
              msg.info.role === "user" && MessageV2.extractText(msg.parts).includes("steer sooner"),
          )

          expect(processedUsers).toEqual([user.id])
          expect(promptPayloads[0]).toContain("steer sooner")
          expect(guided).toBeDefined()
          expect(guided!.info.id).not.toBe(staleMessageID)
          expect(guided!.info.isRoot).toBe(false)
          expect(guided!.info.rootID).toBe(user.id)
          expect(guided!.info.origin?.type).toBe("user")
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })
})

describe("SessionInvoke coauthor reminder prompt", () => {
  test("includes the coauthor reminder by default", async () => {
    await using tmp = await tmpdir({ git: true })
    let activeSessionID = ""
    let systemPrompt = ""
    let lateSystemPrompt = ""
    const restore = installBasicLoopMocks({
      onProcess: async (input) => {
        systemPrompt = input.system.join("\n")
        lateSystemPrompt = input.lateSystem?.join("\n") ?? ""
      },
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser()
          activeSessionID = session.id

          await SessionInvoke.loop.force(session.id)

          expect(systemPrompt).not.toContain("<coauthor-reminder>")
          expect(lateSystemPrompt).toContain("<coauthor-reminder>")
          expect(lateSystemPrompt).toContain("Co-authored-by: synergy-agent")
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })

  test("omits the coauthor reminder when explicitly disabled", async () => {
    await using tmp = await tmpdir({ git: true })
    let activeSessionID = ""
    let systemPrompt = ""
    let lateSystemPrompt = ""
    const restore = installBasicLoopMocks({
      config: { experimental: { coauthor_reminder: false } },
      onProcess: async (input) => {
        systemPrompt = input.system.join("\n")
        lateSystemPrompt = input.lateSystem?.join("\n") ?? ""
      },
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser()
          activeSessionID = session.id

          await SessionInvoke.loop.force(session.id)

          expect(systemPrompt).not.toContain("<coauthor-reminder>")
          expect(systemPrompt).not.toContain("Co-authored-by: synergy-agent")
          expect(lateSystemPrompt).not.toContain("<coauthor-reminder>")
          expect(lateSystemPrompt).not.toContain("Co-authored-by: synergy-agent")
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })
})

describe("SessionInvoke completion notices", () => {
  test("normal terminal assistant completion marks non-silent sessions unread", async () => {
    await using tmp = await tmpdir({ git: true })
    let activeSessionID = ""
    const restore = installBasicLoopMocks()

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser()
          activeSessionID = session.id

          await SessionInvoke.loop.force(session.id)

          expect((await Session.get(session.id)).completionNotice).toEqual({ unread: true, silent: false })
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })

  test("silent session completion leaves unread false", async () => {
    await using tmp = await tmpdir({ git: true })
    let activeSessionID = ""
    const restore = installBasicLoopMocks()

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser({ silent: true })
          activeSessionID = session.id

          await SessionInvoke.loop.force(session.id)

          expect((await Session.get(session.id)).completionNotice).toEqual({ unread: false, silent: true })
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })

  test("explicit cancel completion leaves unread false", async () => {
    await using tmp = await tmpdir({ git: true })
    let activeSessionID = ""
    const restore = installBasicLoopMocks({
      onProcess: async () => {
        SessionInvoke.cancel(activeSessionID)
      },
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser()
          activeSessionID = session.id

          await SessionInvoke.loop.force(session.id)

          expect((await Session.get(session.id)).completionNotice).toEqual({ unread: false, silent: false })
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })

  test("terminal assistant error marks unread unless explicitly aborted", async () => {
    await using tmp = await tmpdir({ git: true })
    let activeSessionID = ""
    const restore = installBasicLoopMocks({
      onProcess: async (_input, assistant) => {
        assistant.error = new MessageV2.APIError({ message: "boom", isRetryable: false }).toObject()
      },
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session } = await createSessionWithUser()
          activeSessionID = session.id

          await expect(SessionInvoke.loop.force(session.id)).rejects.toThrow()

          expect((await Session.get(session.id)).completionNotice).toEqual({ unread: true, silent: false })
        },
      })
    } finally {
      restore()
      if (activeSessionID) SessionManager.unregisterRuntime(activeSessionID)
    }
  })
})

describe("SessionInvoke.cancel", () => {
  test("delegates to signalAbort instead of leaving runtime idle via release", () => {
    Log.init({ print: false })
    const sessionID = "ses_cancel_test"
    const originalRelease = (SessionManager as any).release
    const originalSignalAbort = (SessionManager as any).signalAbort
    const originalClearForSession = (PermissionNext as any).clearForSession
    const runtime = SessionManager.registerRuntime(sessionID)
    try {
      // Simulate a busy runtime that was previously acquired
      runtime.abort = new AbortController()
      runtime.status = { type: "busy", description: "processing..." }

      const releaseSpy = mock(async () => {})
      ;(SessionManager as any).release = releaseSpy

      const signalAbortSpy = mock(() => {})
      ;(SessionManager as any).signalAbort = signalAbortSpy

      // Stub PermissionNext.clearForSession to avoid hitting storage
      const cleanupSpy = mock(() => Promise.resolve())
      ;(PermissionNext as any).clearForSession = cleanupSpy

      SessionInvoke.cancel(sessionID)

      // signalAbort must be called: cancel() should signal the abort,
      // not release the runtime. If cancel() calls release() instead,
      // the runtime transitions to idle before time.completed is set.
      expect(signalAbortSpy).toHaveBeenCalledTimes(1)
      expect(signalAbortSpy).toHaveBeenCalledWith(sessionID)

      // release must NOT be called by cancel: only the defer in loop()
      // should call release after the processor has exited.
      expect(releaseSpy).not.toHaveBeenCalled()
    } finally {
      ;(SessionManager as any).release = originalRelease
      ;(SessionManager as any).signalAbort = originalSignalAbort
      ;(PermissionNext as any).clearForSession = originalClearForSession
      SessionManager.unregisterRuntime(sessionID)
    }
  })
})

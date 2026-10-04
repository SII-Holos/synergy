import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionUserMessageMaterialization } from "../../src/session/user-message-materialization"
import { SessionPromptContext } from "../../src/session/prompt-context"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"
import { SessionProgress } from "../../src/session/progress"
import { SessionHistory } from "../../src/session/history"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function fixture(fn: (root: MessageV2.User) => Promise<void>) {
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ title: "context prefix" })
        const root: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
          isRoot: true,
          rootID: undefined,
          origin: { type: "user" },
          visible: true,
          includeInContext: true,
        }
        root.rootID = root.id
        await SessionUserMessageMaterialization.write({
          info: root,
          parts: [
            {
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: root.id,
              type: "text",
              origin: "user",
              text: "implement the request",
            },
          ],
        })
        await fn(root)
      },
    }),
  )
}

function assistant(root: MessageV2.User, created: number): MessageV2.Assistant {
  return {
    id: Identifier.ascending("message"),
    sessionID: root.sessionID,
    role: "assistant",
    parentID: root.id,
    rootID: root.id,
    agent: root.agent,
    mode: root.agent,
    modelID: "test",
    providerID: "test",
    time: { created },
    path: { cwd: null, root: null },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  }
}

test("prepared context survives readback and three continuations without changing the sent prefix", () =>
  fixture(async (root) => {
    const identity = SessionPromptContext.reserve()
    const next = assistant(root, identity.created)
    const history = await Session.messages({ sessionID: root.sessionID })
    const sections = [{ id: "environment", text: "workspace: first" }]
    const context = await SessionPromptContext.prepare({ root, history, sections, identity, modelKey: "test" })
    expect(context).toBeDefined()
    const sent = MessageV2.toModelMessage([...history, context!])
    await SessionPromptContext.commit(context, next)
    await SessionPromptContext.commit(context, next)
    for (let step = 0; step < 3; step++) {
      const retained = await Session.messages({ sessionID: root.sessionID })
      expect(retained.map((m) => m.info.id)).toEqual([root.id, context!.info.id, next.id])
      expect(MessageV2.toModelMessage(retained)).toEqual(sent)
      expect(
        await SessionPromptContext.prepare({ root, history: retained, sections, modelKey: "test" }),
      ).toBeUndefined()
      expect(SessionUserMessageMaterialization.input(context!)).toBeUndefined()
      expect(MessageV2.lastUserInputIndex(retained)).toBe(0)
    }
  }))

test("changed and removed sections append updates while preserving old text", () =>
  fixture(async (root) => {
    const first = await SessionPromptContext.prepare({
      root,
      history: [],
      sections: [{ id: "git-health", text: "warning" }],
      modelKey: "test",
    })
    const changed = await SessionPromptContext.prepare({
      root,
      history: [first!],
      sections: [{ id: "git-health", text: "new warning" }],
      modelKey: "test",
    })
    expect((changed!.parts[0] as MessageV2.TextPart).text).toContain("new warning")
    expect((first!.parts[0] as MessageV2.TextPart).text).toContain("warning")
    const removed = await SessionPromptContext.prepare({
      root,
      history: [first!, changed!],
      sections: [],
      modelKey: "test",
    })
    expect((removed!.parts[0] as MessageV2.TextPart).text).toContain("no longer applies")
    expect(
      await SessionPromptContext.prepare({
        root,
        history: [first!, changed!, removed!],
        sections: [],
        modelKey: "test",
      }),
    ).toBeUndefined()
  }))

test("a dropped, edited or excluded context cannot suppress reinjection", () =>
  fixture(async (root) => {
    const sections = [{ id: "environment", text: "workspace: first" }]
    const first = await SessionPromptContext.prepare({ root, history: [], sections, modelKey: "test" })
    for (const history of [
      [],
      [{ ...first!, parts: [] }],
      [{ ...first!, info: { ...first!.info, includeInContext: false } }],
    ]) {
      expect(await SessionPromptContext.prepare({ root, history, sections, modelKey: "test" })).toBeDefined()
    }
    const switched = await SessionPromptContext.prepare({
      root,
      history: [first!],
      sections,
      modelKey: "another model",
    })
    expect(switched).toBeDefined()
    expect(
      await SessionPromptContext.prepare({ root, history: [first!, switched!], sections, modelKey: "test" }),
    ).toBeDefined()
    const changed = await SessionPromptContext.prepare({
      root,
      history: [first!],
      sections: [{ id: "environment", text: "workspace: second" }],
      modelKey: "test",
    })
    const edited = {
      ...changed!,
      parts: changed!.parts.map((part) => ({ ...part, text: "rewritten context" })),
    }
    expect(
      await SessionPromptContext.prepare({ root, history: [first!, edited], sections, modelKey: "test" }),
    ).toBeDefined()
  }))

test("task observations are retained once and task-scoped recall refreshes at the next root", () =>
  fixture(async (root) => {
    const sections = [
      { id: "elapsed", text: "one minute", event: true, rootScoped: true },
      { id: "memory", text: "relevant memory", rootScoped: true },
    ]
    const first = await SessionPromptContext.prepare({ root, history: [], sections, modelKey: "test" })
    expect(
      await SessionPromptContext.prepare({ root, history: [first!], sections: sections.slice(1), modelKey: "test" }),
    ).toBeUndefined()
    const nextRoot = { ...root, id: Identifier.ascending("message") }
    expect(
      await SessionPromptContext.prepare({
        root: nextRoot,
        history: [first!],
        sections: sections.slice(1),
        modelKey: "test",
      }),
    ).toBeDefined()
  }))

test("transaction rollback does not advance context and the same preparation can be retried", () =>
  fixture(async (root) => {
    const identity = SessionPromptContext.reserve()
    const context = await SessionPromptContext.prepare({
      root,
      history: [],
      sections: [{ id: "environment", text: "current" }],
      modelKey: "test",
      identity,
    })
    const next = assistant(root, identity.created)
    await expect(
      Storage.transaction(async () => {
        await SessionPromptContext.commit(context, next)
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")
    expect((await Session.messages({ sessionID: root.sessionID })).map((m) => m.info.id)).toEqual([root.id])
    await SessionPromptContext.commit(context, next)
    expect((await Session.messages({ sessionID: root.sessionID })).map((m) => m.info.id)).toEqual([
      root.id,
      context!.info.id,
      next.id,
    ])
  }))

test("external metadata cannot seed the internal comparison state", () => {
  expect(SessionPromptContext.stripMetadata({ promptContext: { version: 1 }, ordinary: "kept" })).toEqual({
    ordinary: "kept",
  })
})

test("rollback and redo compare only the effective history", () =>
  fixture(async (root) => {
    const sections = [{ id: "environment", text: "state one" }]
    const first = await SessionPromptContext.prepare({ root, history: [], sections, modelKey: "test" })
    await SessionPromptContext.commit(first, assistant(root, Date.now()))
    const changedSections = [{ id: "environment", text: "state two" }]
    const second = await SessionPromptContext.prepare({
      root,
      history: [first!],
      sections: changedSections,
      modelKey: "test",
    })
    await SessionPromptContext.commit(second, assistant(root, Date.now()))
    await SessionHistory.rollback({ sessionID: root.sessionID, cutMessageID: second!.info.id })
    const history = await SessionHistory.modelMessages({ sessionID: root.sessionID })
    expect(await SessionPromptContext.prepare({ root, history, sections, modelKey: "test" })).toBeUndefined()
    expect(
      await SessionPromptContext.prepare({ root, history, sections: changedSections, modelKey: "test" }),
    ).toBeDefined()
    await SessionHistory.unrollback({ sessionID: root.sessionID })
    expect(
      await SessionPromptContext.prepare({
        root,
        history: await SessionHistory.modelMessages({ sessionID: root.sessionID }),
        sections: changedSections,
        modelKey: "test",
      }),
    ).toBeUndefined()
  }))

test("fork and transcript import retain text without trusting a foreign comparison baseline", () =>
  fixture(async (root) => {
    const sections = [{ id: "environment", text: "source environment" }]
    const first = await SessionPromptContext.prepare({ root, history: [], sections, modelKey: "test" })
    await SessionPromptContext.commit(first, assistant(root, Date.now()))
    const imported = await SessionImport.fromReport(
      await SessionExport.generate({ sessionID: root.sessionID, mode: "full" }),
    )
    const fork = await Session.fork({ sessionID: root.sessionID })
    for (const sessionID of [imported.rootSessionID, fork.id]) {
      const history = await SessionHistory.modelMessages({ sessionID })
      const target = history.find((m) => m.info.role === "user" && m.info.isRoot)?.info
      if (!target || target.role !== "user") throw new Error("missing imported root")
      expect(
        history.flatMap((m) => m.parts).some((p) => p.type === "text" && p.text.includes("source environment")),
      ).toBe(true)
      expect(
        await SessionPromptContext.prepare({
          root: target,
          history,
          sections: [{ id: "environment", text: "target environment" }],
          modelKey: "test",
        }),
      ).toBeDefined()
      if (sessionID === imported.rootSessionID)
        expect(history.every((m) => m.info.metadata?.promptContext === undefined)).toBe(true)
    }
  }))

test("comparison state is recovered after closing and reopening the Runtime", async () => {
  await using tmp = await tmpdir()
  const sections = [{ id: "environment", text: "same environment after restart" }]
  let root!: MessageV2.User
  const first = await testRuntime({ home: tmp.path })
  try {
    await first.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({})
          const id = Identifier.ascending("message")
          root = {
            id,
            sessionID: session.id,
            role: "user",
            agent: "synergy",
            model: { providerID: "test", modelID: "test" },
            time: { created: Date.now() },
            isRoot: true,
            rootID: id,
            origin: { type: "user" },
          }
          await Session.updateMessage(root)
          const identity = SessionPromptContext.reserve()
          const context = await SessionPromptContext.prepare({
            root,
            history: [],
            sections,
            identity,
            modelKey: "test",
          })
          const response = assistant(root, identity.created)
          response.finish = "stop"
          response.time.completed = Date.now()
          await SessionPromptContext.commit(context, response)
        },
      }),
    )
  } finally {
    await first.close()
  }
  const reopened = await testRuntime({ home: tmp.path })
  try {
    await reopened.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const history = await Session.messages({ sessionID: root.sessionID })
          expect(await SessionPromptContext.prepare({ root, history, sections, modelKey: "test" })).toBeUndefined()
          expect(SessionProgress.needsModelCall(history, root.id)).toBe(false)
        },
      }),
    )
  } finally {
    await reopened.close()
  }
})

test("a committed compaction boundary requires fresh context while a failed attempt keeps the baseline", () =>
  fixture(async (root) => {
    const sections = [{ id: "environment", text: "working directory" }]
    const identity = SessionPromptContext.reserve()
    const context = await SessionPromptContext.prepare({ root, history: [], sections, identity, modelKey: "test" })
    await SessionPromptContext.commit(context, assistant(root, identity.created))
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: root.sessionID,
      messageID: root.id,
      type: "compaction",
      auto: true,
    })
    const summary = assistant(root, Date.now())
    await Session.updateMessage(summary)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: root.sessionID,
      messageID: summary.id,
      type: "text",
      text: "Work summary",
    })
    const before = await MessageV2.filterCompacted(MessageV2.stream({ sessionID: root.sessionID }))
    expect(await SessionPromptContext.prepare({ root, history: before, sections, modelKey: "test" })).toBeUndefined()
    summary.summary = true
    summary.finish = "stop"
    summary.time.completed = Date.now()
    await Session.updateMessage(summary)
    const after = await MessageV2.filterCompacted(MessageV2.stream({ sessionID: root.sessionID }))
    expect(after.some((m) => m.info.id === context!.info.id)).toBe(false)
    expect(await SessionPromptContext.prepare({ root, history: after, sections, modelKey: "test" })).toBeDefined()
  }))

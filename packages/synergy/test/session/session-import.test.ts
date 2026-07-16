import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Dag } from "../../src/session/dag"
import { Todo } from "../../src/session/todo"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { SessionNav } from "../../src/session/nav"
import { Scope } from "../../src/scope"
import { Log } from "../../src/util/log"

Log.init({ print: false })

async function writeExchange(sessionID: string, text: string, metadata?: Record<string, any>) {
  const userID = Identifier.ascending("message")
  await Session.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
    metadata,
  } satisfies MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: userID,
    sessionID,
    type: "text",
    text,
  })

  const assistantID = Identifier.ascending("message")
  await Session.updateMessage({
    id: assistantID,
    sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    parentID: userID,
    modelID: "test",
    providerID: "test",
    mode: "build",
    agent: "synergy",
    path: {
      cwd: ScopeContext.current.directory,
      root: ScopeContext.current.directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } satisfies MessageV2.Assistant)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistantID,
    sessionID,
    type: "text",
    text: `reply: ${text}`,
  })
}

describe("SessionImport", () => {
  test("imports gzipped full export reports with session tree data and indexes", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const scope = ScopeContext.current.scope
        const root = await Session.create({ title: "Export Root" })
        const child = await Session.create({ title: "Export Child", parentID: root.id })

        await writeExchange(root.id, "root prompt", {
          sourceSessionID: child.id,
          nested: { sessionId: child.id },
        })
        await writeExchange(child.id, "child prompt")
        await Dag.update({
          sessionID: root.id,
          nodes: [
            {
              id: "root-task",
              content: "Review imported child",
              status: "completed",
              deps: [],
              session_id: child.id,
              assign: "intent-analyst",
            },
          ],
        })
        await Todo.update({
          sessionID: root.id,
          todos: [{ id: "todo-1", content: "Check import", status: "completed", priority: "high" }],
        })
        await Storage.write(
          StoragePath.sessionSummary(Identifier.asScopeID(scope.id), Identifier.asSessionID(root.id)),
          [{ file: "src/example.ts", additions: 2, deletions: 1, preview: "@@ example" }],
        )

        const report = await SessionExport.generate({ sessionID: root.id, mode: "full" })
        const compressed = Bun.gzipSync(Buffer.from(JSON.stringify(report)))

        await Session.remove(root.id)

        const result = await SessionImport.fromBuffer(compressed)
        const importedRoot = await Session.get(result.rootSessionID)
        const importedChild = result.sessions.find((item) => item.sourceSessionID === child.id)?.session
        expect(result.sessionCount).toBe(2)
        expect(result.messageCount).toBe(4)
        expect(result.warnings).toEqual([])
        expect(importedRoot.id).not.toBe(root.id)
        expect((importedRoot.scope as Scope).id).toBe(scope.id)
        expect(importedRoot.title).toBe("Export Root")
        expect(importedRoot.endpoint).toBeUndefined()
        expect(importedRoot.agenda).toBeUndefined()
        expect(importedRoot.workspace?.path).toBe(scope.directory)

        expect(importedChild).toBeDefined()
        expect(importedChild!.id).not.toBe(child.id)
        expect(importedChild!.parentID).toBe(importedRoot.id)

        const messages = await Session.messages({ sessionID: importedRoot.id, raw: true })
        expect(MessageV2.extractText(messages[0].parts, { includeSynthetic: true })).toBe("root prompt")
        expect(messages[0].info.metadata?.sourceSessionID).toBe(importedChild!.id)
        expect(messages[0].info.metadata?.nested).toEqual({ sessionId: importedChild!.id })

        const dag = await Dag.get(importedRoot.id)
        expect(dag[0].session_id).toBe(importedChild!.id)
        expect(dag[0].assign).toBe("self")
        expect(await Todo.get(importedRoot.id)).toEqual([
          { id: "todo-1", content: "Check import", status: "completed", priority: "high" },
        ])
        expect(await Session.diff(importedRoot.id)).toEqual([
          { file: "src/example.ts", additions: 2, deletions: 1, preview: "@@ example" },
        ])

        const children = await Session.children(importedRoot.id)
        expect(children.map((item) => item.id)).toEqual([importedChild!.id])
        const list = await Session.list({ parentOnly: true })
        expect(list.data.map((item) => item.id)).toContain(importedRoot.id)
        const nav = await SessionNav.queryScope(scope.id)
        expect(nav.items.map((item) => item.id)).toContain(importedRoot.id)
      },
    })
  })

  test("rejects import from a different scope", async () => {
    await using sourceTmp = await tmpdir({ git: true })
    await using targetTmp = await tmpdir({ git: true })
    const sourceScope = await sourceTmp.scope()
    const targetScope = await targetTmp.scope()

    const report = await ScopeContext.provide({
      scope: sourceScope,
      fn: async () => {
        const root = await Session.create({ title: "Cross Scope Export" })
        await writeExchange(root.id, "test message")
        return SessionExport.generate({ sessionID: root.id, mode: "full" })
      },
    })

    await ScopeContext.provide({
      scope: targetScope,
      fn: async () => {
        await expect(SessionImport.fromReport(report)).rejects.toThrow("Cannot import session from scope")
      },
    })
  })

  test("warns when importing into same scope type with different directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const report = await ScopeContext.provide({
      scope,
      fn: async () => {
        const root = await Session.create({ title: "Same Scope Export" })
        await writeExchange(root.id, "test message")
        return SessionExport.generate({ sessionID: root.id, mode: "full" })
      },
    })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const result = await SessionImport.fromReport(report)
        expect(result.sessionCount).toBe(1)
        expect(result.messageCount).toBe(2)
        expect(result.warnings).toEqual([])

        const root = await Session.get(result.rootSessionID)
        expect((root.scope as Scope).id).toBe(scope.id)
      },
    })
  })
})

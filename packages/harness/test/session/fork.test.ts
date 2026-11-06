import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { SessionEvent } from "../../src/session/event"
import { SessionNav } from "../../src/session/nav"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { SessionStaging } from "../../src/session/staging"
import { isDefaultTitle } from "../../src/session/title"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("session fork titles", () => {
  test("publishes sequential source-derived titles without changing the source", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const source = await Session.create({ title: "Design (draft)(7)" })
          const original = await Session.get(source.id)
          const forks: Session.Info[] = []
          const published = new Map<string, string[]>()
          const unsubscribe = Bus.subscribe(SessionEvent.Updated, (event) => {
            const info = event.properties.info
            if (info.forkedFrom?.sessionID !== source.id) return
            published.set(info.id, [...(published.get(info.id) ?? []), info.title])
          })
          try {
            forks.push(await Session.fork({ sessionID: source.id }))
            forks.push(await Session.fork({ sessionID: source.id }))
            expect(forks.map((fork) => fork.title)).toEqual(["Design (draft)(7)(1)", "Design (draft)(7)(2)"])
            for (const fork of forks) {
              expect((await Session.get(fork.id)).title).toBe(fork.title)
              expect(published.get(fork.id)?.[0]).toBe(fork.title)
              expect(isDefaultTitle(fork.title)).toBe(false)
              expect(fork.forkedFrom?.title).toBe(source.title)
              expect(fork.parentID).toBeUndefined()
            }
            expect(await Session.get(source.id)).toEqual(original)
          } finally {
            unsubscribe()
            for (const fork of forks) await Session.remove(fork.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("allocates distinct titles for concurrent forks in the same Scope", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const source = await Session.create({ title: "Concurrent" })
          const forks: Session.Info[] = []
          try {
            const results = await Promise.allSettled(
              Array.from({ length: 8 }, async () => {
                forks.push(await Session.fork({ sessionID: source.id }))
              }),
            )
            for (const result of results) expect(result.status).toBe("fulfilled")
            const expected = Array.from({ length: 8 }, (_, index) => `Concurrent(${index + 1})`)
            expect(forks.map((fork) => fork.title).sort()).toEqual(expected)
            const index = await SessionNav.readNavIndex(scope.id)
            for (const fork of forks) {
              expect((await Session.get(fork.id)).title).toBe(fork.title)
              expect(index.entries.find((entry) => entry.id === fork.id)?.title).toBe(fork.title)
            }
            expect((await Session.get(source.id)).title).toBe("Concurrent")
          } finally {
            for (const fork of forks) await Session.remove(fork.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("continues automatic nested numbering while preserving authored parentheses", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const source = await Session.create({ title: "Plan(3)" })
          const forks: Session.Info[] = []
          try {
            const first = await Session.fork({ sessionID: source.id })
            forks.push(first)
            const nested = await Session.fork({ sessionID: first.id })
            forks.push(nested)
            const deep = await Session.fork({ sessionID: nested.id })
            forks.push(deep)
            expect(forks.map((fork) => fork.title)).toEqual(["Plan(3)(1)", "Plan(3)(2)", "Plan(3)(3)"])
            expect(nested.forkedFrom?.title).toBe(first.title)
            expect(deep.forkedFrom?.title).toBe(nested.title)
            await Session.update(first.id, (draft) => {
              draft.title = "Plan(3)(8)"
            })
            const renamed = await Session.fork({ sessionID: first.id })
            forks.push(renamed)
            expect(renamed.title).toBe("Plan(3)(8)(1)")
            await Session.update(first.id, (draft) => {
              draft.title = first.title
            })
            const restoredName = await Session.fork({ sessionID: first.id })
            forks.push(restoredName)
            expect(restoredName.title).toBe("Plan(3)(1)(1)")
          } finally {
            for (const fork of forks) await Session.remove(fork.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("honors explicit titles including empty and numbered names when they are forked again", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const source = await Session.create({ title: "Source" })
          const forks: Session.Info[] = []
          try {
            for (const title of ["Chosen (draft)", "Source(1)", ""]) {
              const explicit = await Session.fork({ sessionID: source.id, title })
              forks.push(explicit)
              expect(explicit.title).toBe(title)
              expect((await Session.get(explicit.id)).title).toBe(title)
              const nested = await Session.fork({ sessionID: explicit.id })
              forks.push(nested)
              expect(nested.title).toBe(`${title}(1)`)
            }
          } finally {
            for (const fork of forks) await Session.remove(fork.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("retains automatic naming through export/import without guessing from historical lineage", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const source = await Session.create({ title: "Portable" })
          const sessions: Session.Info[] = []
          try {
            const automatic = await Session.fork({ sessionID: source.id })
            sessions.push(automatic)
            const report = await SessionExport.generate({ sessionID: automatic.id, mode: "full" })
            const imported = await SessionImport.fromBuffer(new TextEncoder().encode(JSON.stringify(report)))
            sessions.push(...imported.sessions.map((item) => item.session))
            const nested = await Session.fork({ sessionID: imported.rootSessionID })
            sessions.push(nested)
            expect(nested.title).toBe("Portable(2)")

            delete report.sessions[0]!.info.forkedFrom!.generatedTitle
            const historical = await SessionImport.fromBuffer(new TextEncoder().encode(JSON.stringify(report)))
            sessions.push(...historical.sessions.map((item) => item.session))
            const preserved = await Session.fork({ sessionID: historical.rootSessionID })
            sessions.push(preserved)
            expect(preserved.title).toBe("Portable(1)(1)")
          } finally {
            for (const session of sessions) await Session.remove(session.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("rolls title allocation back with a failed fork publication", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const source = await Session.create({ title: "Atomic" })
          let fork: Session.Info | undefined
          try {
            const failure = new Error("Fork publication failed")
            const finish = spyOn(SessionStaging, "finish").mockRejectedValueOnce(failure)
            try {
              await expect(Session.fork({ sessionID: source.id })).rejects.toThrow(failure)
            } finally {
              finish.mockRestore()
            }
            expect((await SessionNav.readNavIndex(scope.id)).entries.map((entry) => entry.id)).toEqual([source.id])
            fork = await Session.fork({ sessionID: source.id })
            expect(fork.title).toBe("Atomic(1)")
          } finally {
            if (fork) await Session.remove(fork.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("avoids archived and manually named collisions after a navigation index rebuild", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const source = await Session.create({ title: "Indexed" })
          const archived = await Session.create({ title: "Indexed(1)" })
          const manual = await Session.create({ title: "Indexed(2)" })
          let fork: Session.Info | undefined
          try {
            await Session.update(archived.id, (draft) => {
              draft.time.archived = Date.now()
            })
            await Storage.remove(StoragePath.sessionNavIndex(Identifier.asScopeID(scope.id)))
            fork = await Session.fork({ sessionID: source.id })
            expect(fork.title).toBe("Indexed(3)")
          } finally {
            if (fork) await Session.remove(fork.id)
            await Session.remove(manual.id)
            await Session.remove(archived.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("inherits a default source title without leaving the fork eligible for title generation", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const source = await Session.create({})
          let fork: Session.Info | undefined
          try {
            expect(isDefaultTitle(source.title)).toBe(true)
            fork = await Session.fork({ sessionID: source.id })
            expect(fork.title).toBe(`${source.title}(1)`)
            expect(isDefaultTitle(fork.title)).toBe(false)
          } finally {
            if (fork) await Session.remove(fork.id)
            await Session.remove(source.id)
          }
        },
      })
    }))

  test("allocates from the complete title index beyond navigation and metadata page boundaries", async () => {
    await using isolated = await testRuntime()
    await isolated.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const source = await Session.create({ title: "Paged", workspace: null })
          const ids = Array.from({ length: 1_001 }, () => Identifier.descending("session"))
          await Storage.transaction(async (transaction) => {
            await transaction.writeMany(
              ids.map((id, index) => ({
                key: ["sessions", source.scope.id, id, "info"],
                value: { ...source, id, title: `Paged(${index + 1})` },
              })),
            )
            await Storage.remove(StoragePath.sessionNavIndex(Identifier.asScopeID(source.scope.id)))
          })
          const fork = await Session.fork({ sessionID: source.id })
          expect(fork.title).toBe("Paged(1002)")
          expect((await SessionNav.readNavIndex(source.scope.id)).entries).toHaveLength(1_003)
          expect((await SessionNav.queryScope(source.scope.id)).items).toHaveLength(20)
        },
      }),
    )
  }, 30_000)
})

describe("session fork artifact copy", () => {
  test("forks many tool outputs with byte-exact evidence and per-session ownership", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const source = await Session.create({})
          try {
            const root = await Session.updateMessage({
              id: Identifier.ascending("message"),
              sessionID: source.id,
              role: "user",
              agent: "test",
              model: { providerID: "test", modelID: "test" },
              time: { created: 0 },
            })
            const outputs: string[] = []
            let active = 0
            let peak = 0
            for (let index = 0; index < 12; index++) {
              const output = `tool-${index}-${"x".repeat(200_000)}`
              outputs.push(output)
              const assistant = await Session.updateMessage({
                id: Identifier.ascending("message"),
                sessionID: source.id,
                role: "assistant",
                parentID: root.id,
                agent: "test",
                mode: "test",
                modelID: "test",
                providerID: "test",
                time: { created: index + 1, completed: index + 2 },
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                finish: "stop",
              })
              const toolPart = await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: source.id,
                messageID: assistant.id,
                type: "tool",
                callID: `call-${index}`,
                tool: "bash",
                state: {
                  status: "completed",
                  input: {},
                  output,
                  title: `bash ${index}`,
                  metadata: {},
                  time: { start: 0, end: 1 },
                },
              })
              if (toolPart.type !== "tool") throw new Error("Expected a tool part")
              await Session.updatePart({ ...toolPart, id: Identifier.ascending("part"), callID: `copy-${index}` })
            }
            const copy = RolloutArtifact.copy
            let renamed = false
            const copying = spyOn(RolloutArtifact, "copy").mockImplementation(async (...args) => {
              active++
              peak = Math.max(peak, active)
              try {
                if (!renamed) {
                  renamed = true
                  await Session.update(source.id, (draft) => {
                    draft.title = "Renamed during copy"
                  })
                }
                await new Promise((resolve) => setImmediate(resolve))
                return await copy(...args)
              } finally {
                active--
              }
            })
            const fork = await Session.fork({ sessionID: source.id }).finally(() => copying.mockRestore())
            try {
              expect(fork.title).toBe("Renamed during copy(1)")
              expect(fork.forkedFrom?.title).toBe("Renamed during copy")
              const messages = await Session.messages({ sessionID: fork.id })
              const tools = messages.flatMap((message) => message.parts)
              const seen = new Map<string, string>()
              for (const part of tools) {
                if (part.type !== "tool" || part.state.status !== "completed") continue
                const artifact = part.state.outputArtifact
                expect(artifact).toBeDefined()
                const chunks: Uint8Array[] = []
                for await (const chunk of RolloutArtifact.read(
                  { kind: "session", scopeID: scope.id, sessionID: fork.id },
                  artifact!.id,
                ))
                  chunks.push(chunk)
                seen.set(part.callID, Buffer.concat(chunks).toString("utf8"))
              }
              outputs.forEach((output, index) => {
                if (seen.get(`call-${index}`) !== output)
                  throw new Error(`artifact for call-${index} does not match its source output`)
              })
              const sourceArtifacts = await RolloutArtifact.list({
                kind: "session",
                scopeID: scope.id,
                sessionID: source.id,
              })
              const forkArtifacts = await RolloutArtifact.list({
                kind: "session",
                scopeID: scope.id,
                sessionID: fork.id,
              })
              expect(forkArtifacts.length).toBe(outputs.length * 2)
              expect(peak).toBeGreaterThan(1)
              expect(peak).toBeLessThanOrEqual(8)
              expect(active).toBe(0)
              const sourceIds = new Set(sourceArtifacts.map((ref) => ref.id))
              for (const ref of forkArtifacts) expect(sourceIds.has(ref.id)).toBe(false)
            } finally {
              await Session.remove(fork.id)
            }
          } finally {
            await Session.remove(source.id)
          }
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())

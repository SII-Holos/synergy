import { afterAll, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionExport } from "@ericsanchezok/synergy-harness/session/session-export"
import { SessionImport } from "@ericsanchezok/synergy-harness/session/session-import"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { Render } from "../../src/render"
import { RenderTool } from "../../src/tools/render"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function fixture(body: (target: RenderArtifact.Target) => Promise<void>, native = false) {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({})
      try {
        const root = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
        })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: root.id,
          agent: "test",
          mode: "test",
          modelID: "test",
          providerID: "test",
          time: { created: 2, completed: 3 },
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })
        const partID = Identifier.ascending("part")
        const tool = await RenderTool.init()
        const result = await tool.execute(
          tool.parameters.parse(
            native
              ? {
                  ui: {
                    state: { workers: 1 },
                    nodes: [{ id: "workers", type: "slider", label: "Explore", state: "workers", min: 1, max: 8 }],
                  },
                }
              : { html: "<button>Explore</button>" },
          ),
          {
            sessionID: session.id,
            messageID,
            callID: "render-test",
            agent: "test",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          },
        )
        await Session.updatePart({
          id: partID,
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: "render-test",
          tool: "render",
          state: { status: "completed", input: {}, ...result, time: { start: 2, end: 3 } },
        })
        await body({ sessionID: session.id, messageID, partID })
      } finally {
        await Session.remove(session.id)
      }
    },
  })
}

test("render state commits once, rejects racing writes and restores through canonical parts", () =>
  runtime.run(() =>
    fixture(async (target) => {
      const first = await Render.read(target)
      expect(first.state.revision).toBe(0)
      expect((await Render.find(target.sessionID, first.descriptor.source))?.target).toEqual(target)
      expect(await Render.find(target.sessionID, "asset://0000000000000000.bin")).toBeNull()
      const update = {
        revision: 0,
        mutationID: "one",
        content: { modelContent: { workers: 4 }, uiContent: { tab: "chart" } },
      }
      const saved = await Render.write(target, update)
      expect(await Render.write(target, update)).toEqual(saved)
      await expect(Render.write(target, { ...update, mutationID: "two" })).rejects.toBeInstanceOf(Render.Conflict)
      await expect(Render.write(target, { ...update, content: {} })).rejects.toBeInstanceOf(Render.Conflict)
      const parts = await MessageV2.parts({ sessionID: target.sessionID, messageID: target.messageID })
      const tool = parts.find((part) => part.id === target.partID)
      expect(
        tool?.type === "tool" && tool.state.status === "completed" && RenderArtifact.state(tool.state.metadata),
      ).toEqual(saved)
      const race = await Promise.allSettled(
        ["a", "b"].map((mutationID) =>
          Render.write(target, { revision: 1, mutationID, content: { modelContent: mutationID } }),
        ),
      )
      expect(race.filter((entry) => entry.status === "fulfilled")).toHaveLength(1)
      expect((await Render.read(target)).state.revision).toBe(2)
    }),
  ))

test("fork owns its state and source after the source session is removed", () =>
  runtime.run(() =>
    fixture(async (target) => {
      await Render.write(target, { revision: 0, mutationID: "one", content: { modelContent: 4 } })
      const fork = await Session.fork({ sessionID: target.sessionID })
      try {
        const messages = await Session.messages({ sessionID: fork.id })
        const part = messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "render")!
        const copy = { sessionID: fork.id, messageID: part.messageID, partID: part.id }
        expect((await Render.read(copy)).state.content.modelContent).toBe(4)
        await Render.write(copy, { revision: 1, mutationID: "fork", content: { modelContent: 8 } })
        expect((await Render.read(target)).state.content.modelContent).toBe(4)
        await Session.remove(target.sessionID)
        expect((await Render.read(copy)).source.html).toContain("Explore")
      } finally {
        await Session.remove(fork.id)
      }
    }),
  ))

test("cross-Scope, rollback, malformed and stale owner requests cannot update a visual", () =>
  runtime.run(() =>
    fixture(async (target) => {
      await using other = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await other.scope(),
        fn: async () => {
          await expect(Render.read(target)).rejects.toBeInstanceOf(Render.Unavailable)
        },
      })
      await expect(
        Render.write(target, { revision: 0, mutationID: "large", content: { uiContent: "x".repeat(17000) } }),
      ).rejects.toThrow()
      await SessionHistory.rollback({ sessionID: target.sessionID, cutMessageID: target.messageID })
      await expect(Render.read(target)).rejects.toThrow("outside the effective Session history")
    }),
  ))

test("full export and import retain immutable source identity and independently writable state", () =>
  runtime.run(() =>
    fixture(async (target) => {
      const original = await Render.read(target)
      expect(original.source.ui?.state).toEqual({ workers: 1 })
      await Render.write(target, { revision: 0, mutationID: "export", content: { modelContent: { workers: 8 } } })
      const report = await SessionExport.generate({ sessionID: target.sessionID, mode: "full" })
      const imported = await SessionImport.fromReport(report)
      try {
        const match = await Render.find(imported.rootSessionID, original.descriptor.source)
        expect(match).not.toBeNull()
        expect((await Render.read(match!.target)).source).toEqual(original.source)
        expect((await Render.read(match!.target)).state.content.modelContent).toEqual({ workers: 8 })
        await Render.write(match!.target, {
          revision: 1,
          mutationID: "import",
          content: { modelContent: { workers: 4 } },
        })
        expect((await Render.read(target)).state.content.modelContent).toEqual({ workers: 8 })
        await Session.remove(target.sessionID)
        expect((await Render.read(match!.target)).state.content.modelContent).toEqual({ workers: 4 })
      } finally {
        await Session.remove(imported.rootSessionID)
      }
    }, true),
  ))

import { afterAll, expect, test, spyOn } from "bun:test"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RolloutTool } from "@ericsanchezok/synergy-harness/session/rollout/tool"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ChildProcessClose } from "@ericsanchezok/synergy-harness/process/child-process-close"
import { OwnedProcess } from "../../src/process/owned-process"
import { FileMutation } from "../../src/file/mutation"
import { testRuntime } from "../support/runtime"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

const runtime = await testRuntime()
await runtime.run(() => Log.init({ print: true, level: "WARN" }))
afterAll(() => runtime.close())

async function actor() {
  const session = await Session.create()
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  })
  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    parentID: user.id,
    rootID: user.id,
    role: "assistant",
    providerID: "test",
    modelID: "test",
    mode: "synergy",
    agent: "synergy",
    time: { created: Date.now() },
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return {
    session,
    assistant,
    task<T>(fn: () => Promise<T>) {
      return WorkspaceAccess.task({ sessionID: session.id, workspace: ScopeContext.current.workspace }, fn)
    },
    tool<T>(call: string, fn: () => Promise<T>) {
      return RolloutTool.execute(
        {
          owner: { kind: "session", scopeID: ScopeContext.current.scope.id, sessionID: session.id },
          runID: user.id,
          messageID: assistant.id,
          toolCallID: call,
          tool: "write",
          args: {},
        },
        async () => (await fn()) ?? null,
      )
    },
    async patches() {
      return (await MessageV2.get({ sessionID: session.id, messageID: assistant.id })).parts.filter(
        (part): part is MessageV2.PatchPart => part.type === "patch",
      )
    },
  }
}

test(
  "write evidence follows the actual writer across a parent-child handoff",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const a = await actor(),
            b = await actor()
          const same = path.join(tmp.path, "same.txt"),
            foreign = path.join(tmp.path, "foreign.txt")
          await Bun.write(same, "initial\n")
          await Bun.write(foreign, "initial\n")
          try {
            await a.task(async () => {
              await a.tool("first", () => FileMutation.write({ path: same, content: "first\n" }))
              await WorkspaceAccess.handoff(() =>
                b.task(() =>
                  b.tool("foreign", async () => {
                    await FileMutation.write({ path: same, content: "foreign\n" })
                    await FileMutation.write({ path: foreign, content: "foreign\n" })
                  }),
                ),
              )
              await a.tool("last", () => FileMutation.write({ path: same, content: "last\n" }))
            })
            const changes = await a.patches()
            expect(changes).toHaveLength(2)
            expect(changes.map((part) => part.operation?.status)).toEqual(["complete", "complete"])
            expect(changes.map((part) => part.files)).toEqual([[same], [same]])
            const last = changes[1]!
            if (last.operation?.status !== "complete") throw new Error("Missing operation endpoint")
            const diffs = await Snapshot.diffSummary(last.hash, last.operation.afterHash, a.session.id)
            expect(diffs.map((diff) => diff.file)).toEqual(["same.txt"])
            expect(diffs[0]!.patch).toContain("-foreign")
            expect(diffs[0]!.patch).toContain("+last")
            const review = await Session.diff(a.session.id)
            expect(review).toHaveLength(2)
            expect(new Set(review.map((diff) => diff.operationID)).size).toBe(2)
            expect((await Session.get(a.session.id)).summary?.files).toBe(1)
            expect((await b.patches()).flatMap((part) => part.files).sort()).toEqual([foreign, same].sort())
          } finally {
            await Session.remove(a.session.id)
            await Session.remove(b.session.id)
          }
        },
      })
    }),
  30000,
)

test("a read-only tool never attributes an outside writer's changes", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const a = await actor()
        try {
          const file = path.join(tmp.path, "external.txt")
          await a.task(() =>
            a.tool("read", async () => {
              await Bun.write(file, "external actor")
              return Bun.file(file).text()
            }),
          )
          expect(await a.patches()).toEqual([])
        } finally {
          await Session.remove(a.session.id)
        }
      },
    })
  }))

for (const ending of ["complete", "cancel", "remove-session", "switch-workspace"] as const) {
  test(
    `background file evidence survives task exit and ${ending}`,
    () =>
      runtime.run(async () => {
        await using tmp = await tmpdir()
        await using control = await tmpdir()
        await using next = await tmpdir()
        await ScopeContext.provide({
          scope: await tmp.scope(),
          async fn() {
            const a = await actor()
            const file = path.join(tmp.path, "background.txt")
            const ready = path.join(control.path, "ready"),
              finish = path.join(control.path, "finish")
            let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
            try {
              await a.task(() =>
                a.tool("background", async () => {
                  const lease = await WorkspaceAccess.process(null)
                  owned = await OwnedProcess.prepare({
                    command: process.execPath,
                    args: [
                      "-e",
                      `await Bun.write(${JSON.stringify(file)}, 'written'); await Bun.write(${JSON.stringify(ready)}, 'ready'); while (!(await Bun.file(${JSON.stringify(finish)}).exists())) await Bun.sleep(10)`,
                    ],
                    cwd: tmp.path,
                    env: {},
                    lease,
                  })
                  owned.child.stdout.resume()
                  owned.child.stderr.resume()
                  await owned.activate()
                  while (
                    (await Bun.file(ready)
                      .text()
                      .catch(() => "")) !== "ready"
                  )
                    await Bun.sleep(10)
                  return { background: true }
                }),
              )
              expect((await a.patches())[0]?.operation?.status).toBe("pending")
              const excluded = await WorkspaceAccess.write([tmp.path], async () => {}, AbortSignal.timeout(100)).then(
                () => undefined,
                (error: unknown) => error,
              )
              expect(excluded).toMatchObject({ name: "TimeoutError" })
              const done = ChildProcessClose.wait(owned!.child)
              if (ending === "switch-workspace") {
                const target = await WorkspaceBinding.register(ScopeContext.current.scope.id, next.path)
                await Session.updateWorkspace(a.session.id, WorkspaceCatalog.projection(target))
                expect((await Session.get(a.session.id)).workspaceID).toBe(target.id)
              }
              if (ending === "remove-session") await Session.remove(a.session.id)
              if (ending === "complete" || ending === "switch-workspace") await Bun.write(finish, "finish")
              else await owned!.stop()
              await done
              await WorkspaceAccess.write([tmp.path], async () => {})
              if (ending === "remove-session") {
                const removed = await Session.get(a.session.id).then(
                  () => undefined,
                  (error: unknown) => error,
                )
                expect(removed).toBeInstanceOf(Error)
              } else {
                const patches = await a.patches()
                expect(patches).toHaveLength(1)
                expect(patches[0]).toMatchObject({
                  operation: { status: "complete" },
                  files: [file],
                  workspace: { id: a.session.workspaceID, root: tmp.path },
                })
                expect(await Bun.file(path.join(next.path, "background.txt")).exists()).toBe(false)
                const user = (await Session.messages({ sessionID: a.session.id })).find(
                  (message) => message.info.role === "user",
                )
                expect(user?.info.role === "user" && user.info.summary?.diffs.map((diff) => diff.file)).toEqual([
                  "background.txt",
                ])
              }
            } finally {
              await owned?.stop()
              if (ending !== "remove-session") await Session.remove(a.session.id)
            }
          },
        })
      }),
    30000,
  )
}

test("incomplete operation evidence stays visible and cannot authorize restoration", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const a = await actor()
        const file = path.join(tmp.path, "partial.txt")
        await Bun.write(file, "before")
        const comparison = spyOn(Snapshot, "changedPaths").mockRejectedValue(
          new Error("snapshot comparison unavailable"),
        )
        try {
          await a.task(() => a.tool("incomplete", () => FileMutation.write({ path: file, content: "after" })))
          const patches = await a.patches()
          expect(patches).toHaveLength(1)
          expect(patches[0]?.operation?.status).toBe("incomplete")
          const user = (await Session.messages({ sessionID: a.session.id })).find(
            (message) => message.info.role === "user",
          )
          expect(user?.info.role === "user" && user.info.summary?.diffState).toEqual({
            status: "error",
            code: "incomplete",
          })
          const restored = await Session.restoreFiles({ sessionID: a.session.id, messageID: a.assistant.id }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(restored).toMatchObject({ message: expect.stringContaining("incomplete") })
          expect(await Bun.file(file).text()).toBe("after")
        } finally {
          comparison.mockRestore()
          await Session.remove(a.session.id)
        }
      },
    })
  }))

test("explicitly shared Workspace writes retain their own source and never grant snapshot authority to the selected directory", () =>
  runtime.run(async () => {
    await using own = await tmpdir()
    await using shared = await tmpdir()
    await ScopeContext.provide({
      scope: await own.scope(),
      async fn() {
        const a = await actor()
        const source = await WorkspaceCatalog.get(a.session.workspaceID!, a.session.scope.id)
        const target = await WorkspaceBinding.register(a.session.scope.id, shared.path)
        await WorkspaceBinding.setSharing(source.id, {
          scopeID: source.scopeID,
          expectedRevision: source.revision,
          workspaceIDs: [target.id],
        })
        const file = path.join(shared.path, "shared.txt")
        try {
          await a.task(async () => {
            await WorkspaceBinding.writableRoots(ScopeContext.current.workspace!)
            await a.tool("shared-write", () => FileMutation.write({ path: file, content: "shared" }))
          })
          const changes = await a.patches()
          expect(changes).toHaveLength(1)
          expect(changes[0]).toMatchObject({
            workspace: { id: target.id, generation: target.binding.generation, root: shared.path },
            files: [file],
            operation: { status: "complete" },
          })
          expect(await Session.diff(a.session.id)).toMatchObject([
            { file: "shared.txt", workspace: { id: target.id, root: shared.path } },
          ])
          expect(await Bun.file(path.join(own.path, "shared.txt")).exists()).toBe(false)
        } finally {
          await Session.remove(a.session.id)
        }
      },
    })
  }))

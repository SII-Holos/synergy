import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
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
import { OwnedProcess } from "../../src/process/owned-process"
import { FileMutation } from "../../src/file/mutation"
import { testRuntime } from "../support/runtime"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

const runtime = await testRuntime()
await runtime.run(() => Log.init({ print: true, level: "WARN" }))
afterAll(() => runtime.close())

import { SessionFileChanges } from "../../../harness/src/session/file-changes"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"

async function actor() {
  const session = await Session.create()
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    isRoot: true,
    time: { created: Date.now() },
    agent: PrimaryAgentIdentity.names.general,
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
    mode: PrimaryAgentIdentity.names.general,
    agent: PrimaryAgentIdentity.names.general,
    time: { created: Date.now() },
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return {
    session,
    user,
    assistant,
    input: { sessionID: session.id, rootID: user.id, segmentID: crypto.randomUUID() },
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

test("twenty parallel tools and concurrent writers produce two workspace captures", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const file = path.join(tmp.path, "same.txt")
        await Bun.write(file, "dirty baseline\n")
        const a = await actor()
        const captures = spyOn(Snapshot, "track")
        try {
          await SessionFileChanges.begin(a.input)
          await a.task(() =>
            Promise.all(Array.from({ length: 20 }, (_, index) => a.tool(`read-${index}`, () => Bun.file(file).text()))),
          )
          await Bun.write(file, "external change\n")
          await a.task(() => a.tool("write", () => FileMutation.write({ path: file, content: "final\n" })))
          await SessionFileChanges.finish(a.input)
          expect(captures).toHaveBeenCalledTimes(2)
          expect(await a.patches()).toEqual([])
          const diffs = await Session.diff(a.session.id)
          expect(diffs).toHaveLength(1)
          expect(diffs[0]!.patch).toContain("-dirty baseline")
          expect(diffs[0]!.patch).toContain("+final")
          expect((await Session.get(a.session.id)).summary?.diffState).toEqual({ status: "ready" })
        } finally {
          captures.mockRestore()
        }
      },
    })
  }))

test("a tool error after a write does not discard workspace changes", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const a = await actor()
        await SessionFileChanges.begin(a.input)
        const [outcome] = await Promise.allSettled([
          a.task(() =>
            a.tool("error", async () => {
              await FileMutation.write({ path: path.join(tmp.path, "written.txt"), content: "saved" })
              throw new Error("after write")
            }),
          ),
        ])
        expect(outcome).toMatchObject({ status: "rejected", reason: { message: "after write" } })
        await SessionFileChanges.finish(a.input)
        expect(await Session.diff(a.session.id)).toMatchObject([{ file: "written.txt", additions: 1 }])
        expect((await Session.get(a.session.id)).summary?.diffState).toEqual({ status: "ready" })
      },
    })
  }))

test(
  "a background process retains its ownership but cannot rewrite a frozen checkpoint",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const a = await actor()
          const file = path.join(tmp.path, "background.txt")
          let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
          try {
            await SessionFileChanges.begin(a.input)
            await a.task(() =>
              a.tool("background", async () => {
                const lease = await WorkspaceAccess.process([tmp.path])
                owned = await OwnedProcess.prepare({
                  command: process.execPath,
                  args: ["-e", "process.stdin.resume()"],
                  cwd: tmp.path,
                  env: {},
                  ownership: lease,
                })
                owned.child.stdout.resume()
                owned.child.stderr.resume()
                await owned.activate()
              }),
            )
            await Bun.write(file, "at checkpoint\n")
            await SessionFileChanges.finish(a.input)
            const signal = AbortSignal.timeout(100)
            let admitted = false
            const [admission] = await Promise.allSettled([
              WorkspaceAccess.exclusive(
                [tmp.path],
                async () => {
                  admitted = true
                },
                signal,
              ),
            ])
            expect(admission!.status).toBe("rejected")
            if (admission!.status === "rejected")
              expect(admission.reason === signal.reason || admission.reason instanceof WorkspaceAccess.BusyError).toBe(
                true,
              )
            expect(admitted).toBe(false)
            const frozen = await Session.diff(a.session.id)
            await Bun.write(file, "late output\n")
            owned!.child.stdin!.end()
            await owned!.completion
            expect(await Session.diff(a.session.id)).toEqual(frozen)
            await SessionFileChanges.begin({ ...a.input, segmentID: "continuation" })
            await SessionFileChanges.finish({ ...a.input, segmentID: "continuation" })
            expect((await Session.diff(a.session.id))[0]!.patch).toContain("+late output")
          } finally {
            await owned?.stop()
          }
        },
      })
    }),
  30000,
)

test("additional workspaces receive a baseline before their first write and keep distinct identities", () =>
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
        await Bun.write(file, "shared baseline\n")
        await SessionFileChanges.begin(a.input)
        await a.task(async () => {
          await WorkspaceBinding.writableRoots(ScopeContext.current.workspace!)
          await a.tool("shared-write", () => FileMutation.write({ path: file, content: "shared change\n" }))
        })
        await SessionFileChanges.finish(a.input)
        expect(await Session.diff(a.session.id)).toMatchObject([
          { file: "shared.txt", workspace: { id: target.id, root: shared.path } },
        ])
        const full = await SessionHistory.fileDiff({
          sessionID: a.session.id,
          messageID: a.user.id,
          workspaceID: target.id,
          generation: target.binding.generation,
          file: "shared.txt",
        })
        expect(full.patch).toContain("-shared baseline")
        await Bun.write(file, "current unrelated content")
        expect(
          (
            await SessionHistory.fileDiff({
              sessionID: a.session.id,
              workspaceID: target.id,
              generation: target.binding.generation,
              file: "shared.txt",
            })
          ).patch,
        ).toEqual(full.patch)
      },
    })
  }))

test("one workspace capture failure retains the other workspace's net changes", () =>
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
        await SessionFileChanges.begin(a.input)
        await a.task(async () => {
          await WorkspaceBinding.writableRoots(ScopeContext.current.workspace!)
          await a.tool("shared-write", () =>
            FileMutation.write({ path: path.join(shared.path, "shared.txt"), content: "available\n" }),
          )
        })
        const capture = spyOn(Snapshot, "track").mockRejectedValueOnce(new Error("endpoint unavailable"))
        try {
          await SessionFileChanges.finish(a.input)
          expect((await Session.get(a.session.id)).summary?.diffState?.status).toBe("partial")
          expect(await Session.diff(a.session.id)).toMatchObject([{ file: "shared.txt", workspace: { id: target.id } }])
        } finally {
          capture.mockRestore()
        }
      },
    })
  }))

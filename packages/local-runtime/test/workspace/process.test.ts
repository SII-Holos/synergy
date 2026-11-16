import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorktreeProcess } from "../../src/workspace/process"
import { OwnedProcess } from "../../src/process/owned-process"
import { testRuntime as localRuntime } from "../support/runtime"
import { testEnvironmentRuntime } from "@ericsanchezok/synergy-harness/test/support/environment-origin"

const testRuntime = (options: Parameters<typeof localRuntime>[0] = {}) => testEnvironmentRuntime(options, localRuntime)

test("worktree commands retain a supervisor error after activation even when the root exits successfully", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const started = path.join(tmp.path, "started")
    const release = path.join(tmp.path, "release")
    const failure = new Error("Fixture supervisor transport failed")
    const prepare = OwnedProcess.prepare
    using injected = spyOn(OwnedProcess, "prepare").mockImplementation(async (input) => {
      const owned = await prepare(input)
      return {
        ...owned,
        async activate() {
          await owned.activate()
          await waitUntil(() => Bun.file(started).exists())
          owned.child.emit("error", failure)
          await Bun.write(release, "continue")
        },
      }
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const result = await WorktreeProcess.run({
          command: [
            process.execPath,
            "-e",
            "import {rename} from 'node:fs/promises'; await Bun.write(process.argv[1]+'.pending', String(process.pid)); await rename(process.argv[1]+'.pending', process.argv[1]); while (!(await Bun.file(process.argv[2]).exists())) await Bun.sleep(10)",
            started,
            release,
          ],
          directory: tmp.path,
          roots: [tmp.path],
        }).catch((error: unknown) => error)
        expect(result).toBe(failure)
        expect(ProcessInspection.alive(Number(await Bun.file(started).text()))).toBe(false)
        await WorkspaceAccess.write([tmp.path], () => fs.writeFile(path.join(tmp.path, "next-write"), "released"))
        expect(await fs.readFile(path.join(tmp.path, "next-write"), "utf8")).toBe("released")
      },
    })
  })
}, 20000)

test("worktree command cancellation drains the activated native process before releasing ownership", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "started")
    const publish = path.join(tmp.path, "publish")
    const controller = new AbortController()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const running = WorktreeProcess.run({
          command: [
            process.execPath,
            "-e",
            "import {rename} from 'node:fs/promises'; const pending=process.argv[1]+'.pending'; await Bun.write(pending, ''); while (!(await Bun.file(process.argv[2]).exists())) await Bun.sleep(10); await Bun.write(pending, String(process.pid)); await rename(pending, process.argv[1]); setInterval(() => {}, 1000)",
            marker,
            publish,
          ],
          directory: tmp.path,
          roots: [],
          signal: controller.signal,
        }).catch((error: unknown) => error)
        try {
          await waitUntil(() => Bun.file(marker + ".pending").exists())
          expect(await Bun.file(marker).exists()).toBe(false)
          await Bun.write(publish, "continue")
          await waitUntil(() => Bun.file(marker).exists())
          const pid = Number(await Bun.file(marker).text())
          expect(pid).toBeGreaterThan(0)
          controller.abort(new DOMException("Cancelled after activation", "AbortError"))
          const result = await running
          expect(result).toBeInstanceOf(DOMException)
          expect(ProcessInspection.alive(pid)).toBe(false)
          await WorkspaceAccess.write([tmp.path], async () => {
            await fs.writeFile(path.join(tmp.path, "next-write"), "released")
          })
          expect(await fs.readFile(path.join(tmp.path, "next-write"), "utf8")).toBe("released")
        } finally {
          controller.abort(new DOMException("Worktree process fixture closed", "AbortError"))
          await running
        }
      },
    })
  })
}, 20000)

async function waitUntil(fn: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await fn())) {
    if (Date.now() >= deadline) throw new Error("Worktree process did not start")
    await Bun.sleep(20)
  }
}

function processStages(fixture: string) {
  const started = performance.now()
  return (stage: string) => {
    if (process.platform === "win32")
      console.info(JSON.stringify({ fixture, stage, elapsedMs: performance.now() - started }))
  }
}

test("logical Workspaces cannot run worktree preparation callbacks on the controller", async () => {
  const stage = processStages("logical-workspace-process")
  stage("test-enter")
  const { EnvironmentResources } = await import("@ericsanchezok/synergy-harness/environment/resources")
  const { WorkspaceCatalog } = await import("@ericsanchezok/synergy-harness/workspace")
  const { Worktree } = await import("../../src/workspace/worktree")
  stage("imports-ready")
  await using runtime = await testRuntime()
  stage("runtime-ready")
  await runtime.run(async () => {
    stage("runtime-entered")
    await using tmp = await tmpdir({ git: true })
    stage("temporary-project-ready")
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        stage("scope-entered")
        stage("workspace-create-enter")
        const workspace = await WorkspaceCatalog.create({
          scopeID: ScopeContext.current.scope.id,
          backend: { provider: "objects", spec: { blobStore: "local", settings: { namespace: "fixture" } } },
        })
        stage("workspace-create-returned")
        stage("resources-resolve-enter")
        await using resources = await EnvironmentResources.resolve({
          origin: runtime.origin("process-1"),
          scopeID: workspace.scopeID,
          workspaceID: workspace.id,
          needs: { workspace: true },
        })
        stage("resources-resolve-returned")
        stage("readdir-before-enter")
        const before = await fs.readdir(tmp.path)
        stage("readdir-before-returned")
        stage("worktree-negative-enter")
        const outcome = await EnvironmentResources.provide(resources, "worktree", () =>
          Worktree.create({ name: "remote", bind: false, baseRef: "current" }),
        ).then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        stage(outcome.kind === "rejected" ? "worktree-rejected" : "worktree-completed")
        expect(() => {
          if (outcome.kind === "rejected") throw outcome.error
        }).toThrow("native directory Workspace")
        stage("worktree-negative-verified")
        stage("readdir-after-enter")
        expect(await fs.readdir(tmp.path)).toEqual(before)
        stage("readdir-after-returned")
      },
    })
    stage("scope-returned")
  })
  stage("runtime-body-returned")
})

test("a remote Session cannot create a native worktree through its project Scope", async () => {
  const stage = processStages("remote-session-worktree")
  stage("test-enter")
  const { Environment } = await import("@ericsanchezok/synergy-harness/environment")
  const { Session } = await import("@ericsanchezok/synergy-harness/session")
  const { Worktree } = await import("../../src/workspace/worktree")
  stage("imports-ready")
  await using runtime = await testRuntime()
  stage("runtime-ready")
  await runtime.run(async () => {
    stage("runtime-entered")
    await using tmp = await tmpdir({ git: true })
    stage("temporary-project-ready")
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        stage("scope-entered")
        stage("environment-bind-enter")
        const remote = await Environment.bind({
          scopeID: ScopeContext.current.scope.id,
          ownerID: "remote",
          provider: "docker",
          spec: { host: { endpoint: "unix:///absent.sock" }, image: "executor:test" },
        })
        stage("environment-bind-returned")
        stage("session-create-enter")
        const session = await Session.create({ environmentID: remote.id })
        stage("session-create-returned")
        stage("readdir-before-enter")
        const before = await fs.readdir(tmp.path)
        stage("readdir-before-returned")
        stage("worktree-negative-enter")
        const outcome = await Worktree.create({
          sessionID: session.id,
          name: "remote",
          bind: false,
          baseRef: "current",
        }).then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        stage(outcome.kind === "rejected" ? "worktree-rejected" : "worktree-completed")
        expect(() => {
          if (outcome.kind === "rejected") throw outcome.error
        }).toThrow("native Environment")
        stage("worktree-negative-verified")
        stage("readdir-after-enter")
        expect(await fs.readdir(tmp.path)).toEqual(before)
        stage("readdir-after-returned")
        stage("environment-idle-read-enter")
        expect((await Environment.get(remote.id, session.scope.id)).state).toBe("idle")
        stage("environment-idle-read-returned")
      },
    })
    stage("scope-returned")
  })
  stage("runtime-body-returned")
})

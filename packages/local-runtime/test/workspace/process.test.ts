import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorktreeProcess } from "../../src/workspace/process"
import { OwnedProcess } from "../../src/process/owned-process"
import { testRuntime } from "../support/runtime"

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
          roots: null,
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

test("logical Workspaces cannot run worktree preparation callbacks on the controller", async () => {
  const { EnvironmentResources } = await import("@ericsanchezok/synergy-harness/environment/resources")
  const { WorkspaceCatalog } = await import("@ericsanchezok/synergy-harness/workspace")
  const { Worktree } = await import("../../src/workspace/worktree")
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({
          scopeID: ScopeContext.current.scope.id,
          backend: { provider: "objects", spec: { blobStore: "local", settings: { namespace: "fixture" } } },
        })
        await using resources = await EnvironmentResources.resolve({
          scopeID: workspace.scopeID,
          workspaceID: workspace.id,
          needs: { workspace: true },
        })
        const before = await fs.readdir(tmp.path)
        await expect(
          EnvironmentResources.provide(resources, "worktree", () =>
            Worktree.create({ name: "remote", bind: false, baseRef: "current" }),
          ),
        ).rejects.toThrow("native directory Workspace")
        expect(await fs.readdir(tmp.path)).toEqual(before)
      },
    })
  })
})

test("a remote Session cannot create a native worktree through its project Scope", async () => {
  const { Environment } = await import("@ericsanchezok/synergy-harness/environment")
  const { Session } = await import("@ericsanchezok/synergy-harness/session")
  const { Worktree } = await import("../../src/workspace/worktree")
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const remote = await Environment.bind({
          scopeID: ScopeContext.current.scope.id,
          ownerID: "remote",
          provider: "docker",
          spec: { host: { endpoint: "unix:///absent.sock" }, image: "executor:test" },
        })
        const session = await Session.create({ environmentID: remote.id })
        const before = await fs.readdir(tmp.path)
        await expect(
          Worktree.create({ sessionID: session.id, name: "remote", bind: false, baseRef: "current" }),
        ).rejects.toThrow("native Environment")
        expect(await fs.readdir(tmp.path)).toEqual(before)
        expect((await Environment.get(remote.id, session.scope.id)).state).toBe("idle")
      },
    })
  })
})

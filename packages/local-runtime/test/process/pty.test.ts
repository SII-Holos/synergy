import { expect, spyOn, test } from "bun:test"
import { Pty } from "../../src/process/pty"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import path from "node:path"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { NativePty } from "../../src/process/native-pty"
import { OwnedProcess } from "../../src/process/owned-process"
const runtime = await testRuntime()

test.each(["missing-library", "cancelled-preparation"] as const)(
  "a failed terminal launch releases native write ownership: %s",
  (failure) =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const prepare = OwnedProcess.prepare
          const probe =
            failure === "missing-library"
              ? spyOn(NativePty, "libraryPath").mockImplementationOnce(() => {
                  throw new Error("Fixture PTY library unavailable")
                })
              : spyOn(OwnedProcess, "prepare").mockImplementationOnce((input) =>
                  prepare({ ...input, signal: AbortSignal.abort(new Error("Fixture preparation cancelled")) }),
                )
          try {
            await expect(Pty.create({ command: process.execPath })).rejects.toThrow("Fixture")
          } finally {
            probe.mockRestore()
          }
          expect(Pty.list()).toHaveLength(0)
          const marker = path.join(directory.path, "after-failed-terminal")
          await WorkspaceAccess.write(
            [directory.path],
            () => Bun.write(marker, "admitted"),
            AbortSignal.timeout(10_000),
          )
          expect(await Bun.file(marker).text()).toBe("admitted")
        },
      })
    }),
  30_000,
)

test.skipIf(process.platform === "win32")(
  "local PTY accepts input, emits native output and releases its session",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const info = await Pty.create({ command: "/bin/cat", cwd: directory.path })
          let output = ""
          let resolveOutput!: () => void
          let closed = false
          const received = new Promise<void>((resolve) => {
            resolveOutput = resolve
          })
          try {
            Pty.connect(info.id, {
              readyState: 1,
              send(data) {
                output += data
                if (output.includes("local-pty-owned")) resolveOutput()
              },
              close() {
                closed = true
              },
            })
            await Pty.update(info.id, { title: "Research terminal", size: { cols: 100, rows: 40 } })
            expect(Pty.get(info.id)?.title).toBe("Research terminal")
            Pty.write(info.id, "local-pty-owned\n")
            await received
            expect(output).toContain("local-pty-owned")
          } finally {
            await Pty.remove(info.id)
          }
          expect(closed).toBe(true)
          expect(Pty.get(info.id)).toBeUndefined()
        },
      })
    }),
  30_000,
)

test.skipIf(process.platform === "win32")(
  "native PTY preserves split UTF-8 and drains output before announcing exit",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const info = await Pty.create({
            command: process.execPath,
            args: [
              "-e",
              'process.stdin.once("data", () => { process.stdout.write("你好🙂".repeat(10000) + "TAIL", () => process.exit(0)) })',
            ],
          })
          let output = ""
          const closed = Promise.withResolvers<void>()
          Pty.connect(info.id, {
            readyState: 1,
            send(data) {
              output += data
            },
            close() {
              closed.resolve()
            },
          })
          try {
            Pty.write(info.id, "start\n")
            await closed.promise
            expect(output.includes("\uFFFD")).toBe(false)
            expect(output.endsWith("TAIL")).toBe(true)
            expect(output.match(/你好🙂/gu)?.length).toBe(10000)
          } finally {
            await Pty.remove(info.id)
          }
        },
      })
    }),
  30_000,
)

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a disconnected PTY retains its binding and detached descendants until removal completes",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await using next = await tmpdir()
      const scope = await directory.scope()
      await ScopeContext.provide({
        scope,
        async fn() {
          const session = await Session.create()
          const workspace = await WorkspaceCatalog.get(session.workspaceID!, scope.id)
          const ready = path.join(directory.path, "descendant.json")
          const program = `await Bun.write(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)`
          const launch = `const { spawn } = require("node:child_process"); process.stdin.once("data", () => { const child = spawn(process.execPath, ["-e", ${JSON.stringify(program)}], { detached: true, stdio: "ignore", env: {} }); child.unref(); process.exit(0) })`
          const info = await Pty.create({ sessionID: session.id, command: process.execPath, args: ["-e", launch] })
          const client = { readyState: 1, send(_data: string) {}, close() {} }
          const connection = Pty.connect(info.id, client)!
          try {
            connection.onMessage(new TextEncoder().encode("start\n").buffer)
            connection.onClose()
            const deadline = Date.now() + 5000
            while (!(await Bun.file(ready).exists())) {
              if (Date.now() >= deadline) throw new Error("PTY descendant did not start")
              await Bun.sleep(5)
            }
            expect(Pty.get(info.id)?.workspaceID).toBe(session.workspaceID!)
            expect(Pty.get(info.id)?.workspaceGeneration).toBe(workspace.binding.generation)
            await expect(
              WorkspaceBinding.rebind(workspace.id, {
                scopeID: scope.id,
                expectedRevision: workspace.revision,
                path: next.path,
              }),
            ).rejects.toThrow("busy")
            await expect(
              WorkspaceAccess.write([directory.path], async () => {}, AbortSignal.timeout(30)),
            ).rejects.toMatchObject({ name: "TimeoutError" })
            await Pty.remove(info.id)
            expect(Pty.get(info.id)).toBeUndefined()
            const child = await Bun.file(ready).json()
            expect(() => process.kill(child.pid, 0)).toThrow()
            await WorkspaceBinding.rebind(workspace.id, {
              scopeID: scope.id,
              expectedRevision: workspace.revision,
              path: next.path,
            })
          } finally {
            await Pty.remove(info.id)
          }
        },
      })
    }),
  30_000,
)

test.skipIf(process.platform === "win32")(
  "slow and oversized terminal clients are disconnected without killing the terminal",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const info = await Pty.create({ command: "/bin/cat" })
          try {
            const closed = Promise.withResolvers<void>()
            Pty.connect(info.id, {
              readyState: 1,
              bufferedAmount: 4 * 1024 * 1024,
              send() {
                throw new Error("must not enqueue")
              },
              close: closed.resolve,
            })
            Pty.write(info.id, "slow-client\n")
            await closed.promise
            expect(Pty.get(info.id)?.status).toBe("running")
            let rejected = false
            const connection = Pty.connect(info.id, {
              readyState: 1,
              send() {},
              close() {
                rejected = true
              },
            })!
            connection.onMessage("x".repeat(256 * 1024 + 1))
            expect(rejected).toBe(true)
            expect(Pty.get(info.id)?.status).toBe("running")
          } finally {
            await Pty.remove(info.id)
          }
        },
      })
    }),
  30_000,
)

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Workspace disposal cancels a terminal launch waiting for native write ownership",
  () =>
    runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const id = ScopeContext.current.workspace!.id!
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const writer = WorkspaceAccess.write(null, async () => {
            entered.resolve()
            await release.promise
          })
          await entered.promise
          const pending = Pty.create({ command: "/bin/cat" })
          void pending.catch(() => {})
          try {
            await WorkspaceState.disposeWorkspace(id)
            const outcome = await Promise.race([
              pending.then(
                () => "created",
                () => "cancelled",
              ),
              Bun.sleep(200).then(() => "still waiting"),
            ])
            expect(outcome).toBe("cancelled")
          } finally {
            release.resolve()
            await writer
            const created = await pending.catch(() => undefined)
            if (created) await Pty.remove(created.id)
          }
        },
      })
    }),
  30_000,
)

afterRuntimeTests(() => runtime.close())

import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { StreamMessageReader } from "vscode-jsonrpc/node"
import { LSPClient } from "../../src/client"
import { LSP } from "../../src/index"
import { LSPProcess } from "../../src/process"
import { LSPServer } from "../../src/server"
import { WorkspaceFileSymbolSource } from "@ericsanchezok/synergy-local-runtime/workspace-file/symbol-source"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("configured LSP owner serves real protocol queries and releases its processes on reload", () =>
  runtime.run(async () => {
    const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
    await using tmp = await tmpdir({
      config: {
        lsp: {
          ...disabled,
          fixture: {
            command: [process.execPath, path.join(import.meta.dir, "fixtures/owner-server.cjs")],
            extensions: [".fixture"],
          },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        try {
          const file = path.join(tmp.path, "source.fixture")
          await Bun.write(file, "let ownerSymbol = 1")
          expect(await LSP.hasClients(file)).toBe(true)
          expect(await LSP.hasClients(path.join(tmp.path, "other.unconfigured"))).toBe(false)
          expect(await LSP.status()).toEqual([])
          await LSP.touchFile(file, true)
          expect((await LSP.diagnostics())[file]?.[0]?.message).toBe("fixture warning")
          const input = { file, line: 0, character: 1 }
          expect(await LSP.hover(input)).toEqual([{ contents: "fixture hover" }])
          expect(await LSP.definition(input)).toEqual([
            {
              uri: pathToFileURL(file).href,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ])
          expect(await LSP.references(input)).toHaveLength(1)
          expect(await LSP.implementation(input)).toHaveLength(1)
          expect(await LSP.documentSymbol(pathToFileURL(file).href)).toHaveLength(1)
          expect(await LSP.workspaceSymbol("symbol")).toHaveLength(10)
          expect(await LSP.prepareCallHierarchy(input)).toHaveLength(1)
          expect(await LSP.incomingCalls(input)).toHaveLength(1)
          expect(await LSP.outgoingCalls(input)).toHaveLength(1)
          await LSP.reload()
          expect(await LSP.status()).toEqual([])
        } finally {
          await LSP.reload()
        }
      },
    })
  }))

test("starting another Workspace preserves both native LSP processes and independent diagnostics", () =>
  runtime.run(async () => {
    const { Session } = await import("@ericsanchezok/synergy-harness/session")
    const { ProcessInspection } = await import("@ericsanchezok/synergy-harness/process/inspection")
    const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
    await using first = await tmpdir({
      config: {
        lsp: {
          ...disabled,
          fixture: {
            command: [
              process.execPath,
              "-e",
              "await Bun.write('server.pid',String(process.pid));await import(process.argv[1])",
              path.join(import.meta.dir, "fixtures/owner-server.cjs"),
            ],
            extensions: [".fixture"],
          },
        },
      },
    })
    await using second = await tmpdir()
    const scope = await first.scope()
    const sessions = await ScopeContext.provide({
      scope,
      fn: async () => [
        await Session.create({}),
        await Session.create({ workspace: { type: "directory", scopeID: scope.id, path: second.path } }),
      ],
    })
    try {
      for (const session of sessions)
        await ScopeContext.provide({
          scope,
          workspace: session.workspace,
          fn: async () => {
            const file = path.join(session.workspace!.path, "source.fixture")
            await Bun.write(file, "let symbol = 1")
            await LSP.touchFile(file, true)
            expect(Object.keys(await LSP.diagnostics())).toEqual([file])
          },
        })
      const pids = await Promise.all(
        [first, second].map(async (directory) =>
          Number(await Bun.file(path.join(directory.path, "server.pid")).text()),
        ),
      )
      expect(pids[0]).not.toBe(pids[1])
      expect(ProcessInspection.alive(pids[0]!)).toBe(true)
      expect(ProcessInspection.alive(pids[1]!)).toBe(true)
      await ScopeContext.provide({
        scope,
        workspace: sessions[0]!.workspace,
        fn: async () => {
          const file = path.join(first.path, "source.fixture")
          expect(Object.keys(await LSP.diagnostics())).toEqual([file])
          expect(await LSP.hover({ file, line: 0, character: 0 })).toEqual([{ contents: "fixture hover" }])
          expect(Number(await Bun.file(path.join(first.path, "server.pid")).text())).toBe(pids[0])
        },
      })
    } finally {
      await LSP.reload()
    }
  }))

test(
  "Workspace retirement waits for an active LSP query then drains its idle process",
  () =>
    runtime.run(async () => {
      const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
      await using tmp = await tmpdir({
        config: {
          lsp: {
            ...disabled,
            fixture: {
              command: [process.execPath, path.join(import.meta.dir, "fixtures/owner-server.cjs")],
              extensions: [".fixture"],
              env: { LSP_FIXTURE_HOLD_QUERY: "1" },
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          try {
            const file = path.join(tmp.path, "source.fixture")
            await Bun.write(file, "let ownerSymbol = 1")
            await LSP.touchFile(file, true)
            const query = LSP.hover({ file, line: 0, character: 0 })
            void query.catch(() => {})
            const started = path.join(tmp.path, "query-started")
            const deadline = Date.now() + 5000
            while (!(await Bun.file(started).exists()) && Date.now() < deadline) await Bun.sleep(10)
            expect(await Bun.file(started).exists()).toBe(true)
            expect(await LSP.status()).toEqual([{ id: "fixture", name: "fixture", root: "", status: "connected" }])
            const pid = Number(await Bun.file(path.join(tmp.path, "server.pid")).text())
            let committed = false
            const retire = (signal?: AbortSignal) =>
              WorkspaceAccess.exclusive(
                [tmp.path],
                async () => {
                  expect(await Bun.file(path.join(tmp.path, "query-completed")).text()).toBe("replied\n")
                  expect(ProcessInspection.alive(pid)).toBe(false)
                  await Bun.write(file, "let ownerSymbol = 2")
                  committed = true
                },
                signal,
              )
            await expect(retire()).rejects.toMatchObject({ name: "WorkspaceBusyError" })
            expect(committed).toBe(false)
            expect(ProcessInspection.alive(pid)).toBe(true)
            expect(await Bun.file(path.join(tmp.path, "query-completed")).exists()).toBe(false)
            await Bun.write(path.join(tmp.path, "query-release"), "release")
            expect(await query).toEqual([{ contents: "fixture hover" }])
            const signal = AbortSignal.timeout(5000)
            for (;;) {
              try {
                await retire(signal)
                break
              } catch (error) {
                signal.throwIfAborted()
                if (!(error instanceof WorkspaceAccess.BusyError)) throw error
              }
            }
            expect(committed).toBe(true)
            expect((await LSP.diagnostics())[file]?.[0]?.message).toBe("fixture warning")
            expect(await LSP.hover({ file, line: 0, character: 0 })).toEqual([{ contents: "fixture hover" }])
          } finally {
            await Bun.write(path.join(tmp.path, "query-release"), "release")
            await LSP.reload()
          }
        },
      })
    }),
  15000,
)

test(
  "multiple matching LSP servers answer sequentially without retaining a competing idle writer",
  () =>
    runtime.run(async () => {
      const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
      const fixture = {
        command: [process.execPath, path.join(import.meta.dir, "fixtures/owner-server.cjs")],
        extensions: [".fixture"],
      }
      await using tmp = await tmpdir({ config: { lsp: { ...disabled, first: fixture, second: fixture } } })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          try {
            const file = path.join(tmp.path, "source.fixture")
            await Bun.write(file, "let ownerSymbol = 1")
            await LSP.touchFile(file, true)
            expect((await LSP.diagnostics())[file]).toHaveLength(2)
            expect(await LSP.hover({ file, line: 0, character: 0 })).toEqual([
              { contents: "fixture hover" },
              { contents: "fixture hover" },
            ])
            expect(await LSP.workspaceSymbol("symbol")).toHaveLength(20)
          } finally {
            await LSP.reload()
          }
        },
      })
    }),
  20000,
)

afterRuntimeTests(() => runtime.close())

test(
  "cancelling one shared LSP query preserves another active query and then releases native ownership",
  () =>
    runtime.run(async () => {
      const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
      await using tmp = await tmpdir({
        config: {
          lsp: {
            ...disabled,
            fixture: {
              command: [process.execPath, path.join(import.meta.dir, "fixtures/owner-server.cjs")],
              extensions: [".fixture"],
              env: { LSP_FIXTURE_DELAY_MS: "800" },
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const controller = new AbortController()
          try {
            const file = path.join(tmp.path, "source.fixture")
            await Bun.write(file, "let ownerSymbol = 1")
            await LSP.touchFile(file, true)
            const input = { file, line: 0, character: 0 }
            const first = WorkspaceAccess.task(
              { workspace: ScopeContext.current.workspace, signal: controller.signal },
              () => LSP.hover(input),
            )
            const failure = first.then(
              () => undefined,
              (error: unknown) => error,
            )
            const second = LSP.hover(input)
            const marker = path.join(tmp.path, "query-started")
            const deadline = Date.now() + 5000
            while (
              (
                await Bun.file(marker)
                  .text()
                  .catch(() => "")
              ).split("\n").length < 3
            ) {
              if (Date.now() >= deadline) throw new Error("Concurrent language server queries did not start")
              await Bun.sleep(10)
            }
            const pid = Number(await Bun.file(path.join(tmp.path, "server.pid")).text())
            controller.abort()
            expect(ProcessInspection.alive(pid)).toBe(true)
            expect(await second).toEqual([{ contents: "fixture hover" }])
            expect(await failure).toMatchObject({ name: "AbortError" })
            await WorkspaceAccess.write([tmp.path], async () => {
              expect(ProcessInspection.alive(pid)).toBe(false)
            })
          } finally {
            controller.abort()
            await LSP.reload()
          }
        },
      })
    }),
  15000,
)

test(
  "reload cancels a queued LSP startup without launching a late process",
  () =>
    runtime.run(async () => {
      const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
      await using tmp = await tmpdir({
        config: {
          lsp: {
            ...disabled,
            fixture: {
              command: [process.execPath, path.join(import.meta.dir, "fixtures/owner-server.cjs")],
              extensions: [".fixture"],
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const held = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const writer = WorkspaceAccess.maintenance(async () => {
            const legacy = await WorkspaceAccess.hostClaim({ id: crypto.randomUUID(), kind: "process", roots: null })
            try {
              held.resolve()
              await release.promise
            } finally {
              await legacy.release()
            }
          })
          await held.promise
          const query = WorkspaceAccess.task({ workspace: ScopeContext.current.workspace, lazy: true }, () =>
            LSP.hover({ file: path.join(tmp.path, "source.fixture"), line: 0, character: 0 }),
          )
          const failure = query.then(
            () => undefined,
            (error: unknown) => error,
          )
          try {
            const deadline = Date.now() + 5000
            while (!(await LSP.connectionCount())) {
              if (Date.now() >= deadline) throw new Error("Language server startup was not registered")
              await Bun.sleep(10)
            }
            await LSP.reload()
            expect(await failure).toMatchObject({ name: "AbortError" })
            expect(await Bun.file(path.join(tmp.path, "server.pid")).exists()).toBe(false)
          } finally {
            release.resolve()
            await writer
            await LSP.reload()
          }
        },
      })
    }),
  15000,
)

test(
  "cancelling the first startup does not poison another query sharing its startup promise",
  () =>
    runtime.run(async () => {
      const disabled = Object.fromEntries(Object.values(LSPServer).map((server) => [server.id, { disabled: true }]))
      await using tmp = await tmpdir({
        config: {
          lsp: {
            ...disabled,
            fixture: {
              command: [process.execPath, path.join(import.meta.dir, "fixtures/owner-server.cjs")],
              extensions: [".fixture"],
              env: { LSP_FIXTURE_HOLD_INIT: "1" },
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const controller = new AbortController()
          const secondController = new AbortController()
          const initializing = Promise.withResolvers<number | undefined>()
          const start = LSPProcess.start
          using launch = spyOn(LSPProcess, "start").mockImplementation((...args) =>
            start(...args).catch((error) => {
              initializing.reject(new Error("Native LSP startup failed before initialization", { cause: error }))
              throw error
            }),
          )
          const create = LSPClient.create
          using observe = spyOn(LSPClient, "create").mockImplementation((input) => {
            const reader = new StreamMessageReader(input.server.process.stdout)
            const listening = reader.listen((message) => {
              if ("method" in message && message.method === "fixture/initializing")
                initializing.resolve(input.server.process.pid)
            })
            return create(input)
              .catch((error) => {
                initializing.reject(
                  new Error("LSP initialization failed before the fixture handshake", { cause: error }),
                )
                throw error
              })
              .finally(() => {
                listening.dispose()
                reader.dispose()
              })
          })
          const input = { file: path.join(tmp.path, "source.fixture"), line: 0, character: 0 }
          const first = WorkspaceAccess.task(
            { workspace: ScopeContext.current.workspace, signal: controller.signal, lazy: true },
            () => LSP.hover(input),
          )
          const failure = first.then(
            () => undefined,
            (error: unknown) => error,
          )
          const second = WorkspaceAccess.task(
            { workspace: ScopeContext.current.workspace, signal: secondController.signal, lazy: true },
            () => LSP.hover(input),
          )
          const deadline = Promise.withResolvers<never>()
          let phase = "initialization handshake"
          const timer = setTimeout(() => {
            const error = new DOMException(`LSP fixture timed out during ${phase}`, "TimeoutError")
            deadline.reject(error)
            controller.abort(error)
            secondController.abort(error)
          }, 10_000)
          try {
            const firstPID = await Promise.race([
              initializing.promise,
              deadline.promise,
              failure.then((error) => {
                throw new Error("First query completed before LSP initialization", { cause: error })
              }),
              second.then(() => {
                throw new Error("Second query completed before LSP initialization")
              }),
            ])
            expect(firstPID).toBeNumber()
            phase = "shared startup recovery"
            await Bun.write(path.join(tmp.path, "initialize-release"), "ready")
            controller.abort()
            const [error, result] = await Promise.race([Promise.all([failure, second]), deadline.promise])
            expect(error).toMatchObject({ name: "AbortError" })
            expect(result).toEqual([{ contents: "fixture hover" }])
            expect(ProcessInspection.alive(firstPID!)).toBe(false)
            expect(Number(await Bun.file(path.join(tmp.path, "server.pid")).text())).not.toBe(firstPID)
            expect(launch).toHaveBeenCalledTimes(2)
            expect(observe).toHaveBeenCalledTimes(2)
          } finally {
            clearTimeout(timer)
            controller.abort()
            secondController.abort()
            await Promise.allSettled([first, second])
            await LSP.reload()
          }
        },
      })
    }),
  15000,
)

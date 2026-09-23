import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LSP } from "../../src/lsp"
import { LSPServer } from "../../src/lsp/server"
import { WorkspaceFileSymbolSource } from "@ericsanchezok/synergy-runtime-local/workspace-file/symbol-source"
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

test("starting another Workspace retires idle unconfined LSP processes and preserves independent diagnostics", () =>
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
      expect(ProcessInspection.alive(pids[0]!)).toBe(false)
      expect(ProcessInspection.alive(pids[1]!)).toBe(true)
      await ScopeContext.provide({
        scope,
        workspace: sessions[0]!.workspace,
        fn: async () => {
          const file = path.join(first.path, "source.fixture")
          expect(Object.keys(await LSP.diagnostics())).toEqual([file])
          expect(await LSP.hover({ file, line: 0, character: 0 })).toEqual([{ contents: "fixture hover" }])
          expect(Number(await Bun.file(path.join(first.path, "server.pid")).text())).not.toBe(pids[0])
        },
      })
    } finally {
      await LSP.reload()
    }
  }))

test(
  "a competing writer waits for an active LSP query then retires the idle process before writing",
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
              env: { LSP_FIXTURE_DELAY_MS: "600" },
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
            const started = path.join(tmp.path, "query-started")
            const deadline = Date.now() + 5000
            while (!(await Bun.file(started).exists()) && Date.now() < deadline) await Bun.sleep(10)
            expect(await Bun.file(started).exists()).toBe(true)
            expect(await LSP.status()).toEqual([{ id: "fixture", name: "fixture", root: "", status: "connected" }])
            const pid = Number(await Bun.file(path.join(tmp.path, "server.pid")).text())
            const writer = WorkspaceAccess.write([tmp.path], async () => {
              expect(await Bun.file(path.join(tmp.path, "query-completed")).text()).toBe("replied\n")
              expect(ProcessInspection.alive(pid)).toBe(false)
              await Bun.write(file, "let ownerSymbol = 2")
            })
            const [result] = await Promise.all([query, writer])
            expect(result).toEqual([{ contents: "fixture hover" }])
            expect((await LSP.diagnostics())[file]?.[0]?.message).toBe("fixture warning")
            expect(await LSP.hover({ file, line: 0, character: 0 })).toEqual([{ contents: "fixture hover" }])
          } finally {
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
          const writer = WorkspaceAccess.write(null, async () => {
            held.resolve()
            await release.promise
          })
          await held.promise
          const query = LSP.hover({ file: path.join(tmp.path, "source.fixture"), line: 0, character: 0 })
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
              env: { LSP_FIXTURE_INIT_DELAY_MS: "700" },
            },
          },
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const controller = new AbortController()
          const input = { file: path.join(tmp.path, "source.fixture"), line: 0, character: 0 }
          const first = WorkspaceAccess.task(
            { workspace: ScopeContext.current.workspace, signal: controller.signal },
            () => LSP.hover(input),
          )
          const failure = first.then(
            () => undefined,
            (error: unknown) => error,
          )
          try {
            const deadline = Date.now() + 5000
            while (!(await Bun.file(path.join(tmp.path, "initializing")).exists())) {
              if (Date.now() >= deadline) throw new Error("First language server did not begin initialization")
              await Bun.sleep(10)
            }
            const firstPID = Number(await Bun.file(path.join(tmp.path, "server.pid")).text())
            const second = LSP.hover(input)
            await Bun.sleep(30)
            controller.abort()
            const [error, result] = await Promise.all([failure, second])
            expect(error).toMatchObject({ name: "AbortError" })
            expect(result).toEqual([{ contents: "fixture hover" }])
            expect(ProcessInspection.alive(firstPID)).toBe(false)
            expect(Number(await Bun.file(path.join(tmp.path, "server.pid")).text())).not.toBe(firstPID)
          } finally {
            controller.abort()
            await first.catch(() => {})
            await LSP.reload()
          }
        },
      })
    }),
  15000,
)

import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { lsp } from "../../src/component"
import { LSPProcess } from "../../src/process"

async function nativeTask(environmentID: string) {
  const session = await Session.create({ environmentID, workspaceID: null })
  const rootID = Identifier.ascending("message")
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    sessionID: session.id,
    role: "user",
    time: { created: 1 },
    rootID,
    isRoot: true,
    agent: "general",
    model: { providerID: "fixture", modelID: "fixture" },
  })
  const owner = RolloutLifecycle.owner(session)
  await RolloutLedger.beginRun(owner, rootID)
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    parentID: rootID,
    rootID,
    agent: "general",
    modelID: "fixture",
    providerID: "fixture",
    mode: "default",
    time: { created: 2 },
    path: { cwd: null, root: null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await RolloutLedger.beginTool({ owner, runID: rootID, messageID, toolCallID: "lsp-query", tool: "lsp", args: {} })
  return {
    session,
    origin: EnvironmentOrigin.selected({
      kind: "session",
      scopeID: session.scope.id,
      sessionID: session.id,
      rootID,
      runID: rootID,
      messageID,
      callID: "lsp-query",
      tool: "lsp",
    }),
  }
}

test("a shared native language server survives its first Task pause while a paused Task cannot launch another server", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime({
          workspaceCoordinator: new WorkspaceCoordinator({
            directory: path.join(RuntimeContext.current().host.root, "claims"),
          }),
        })
        lsp().register()
      },
    },
  })
  await runtime.run(async () => {
    await using directory = await tmpdir()
    const scope = await directory.scope()
    await ScopeContext.provide({
      scope,
      fn: () =>
        WorkspaceAccess.withinTask(async () => {
          const environment = await Environment.bind({
            scopeID: scope.id,
            ownerID: "lsp-fixture",
            provider: "native",
            spec: {},
          })
          const task = await nativeTask(environment.id)
          await using resources = await EnvironmentResources.resolve({
            scopeID: scope.id,
            environmentID: environment.id,
            origin: task.origin,
            needs: { execution: "exec" },
          })
          await EnvironmentResources.provide(resources, "first-task", async () => {
            const owned = await LSPProcess.start(
              {
                command: process.execPath,
                args: [
                  "-e",
                  "process.stdout.write('ready');process.stdin.on('data', data => process.stdout.write(data))",
                ],
                cwd: directory.path,
              },
              AbortSignal.timeout(10000),
            )
            let output = ""
            const ready = Promise.withResolvers<void>()
            const echoed = Promise.withResolvers<void>()
            owned.child.stdout.on("data", (bytes) => {
              output += bytes.toString()
              if (output.includes("ready")) ready.resolve()
              if (output.includes("after-pause")) echoed.resolve()
            })
            owned.child.stderr.resume()
            try {
              await owned.activate()
              await ready.promise
              await SessionLifecycle.pause({ sessionID: task.session.id, reason: "interrupted" })
              await expect(
                EnvironmentExecution.assertSessionDrained(scope.id, task.session.id, environment.id),
              ).rejects.toMatchObject({ name: "EnvironmentBusy" })
              await resources.release()
              await EnvironmentExecution.assertSessionDrained(scope.id, task.session.id, environment.id)
              owned.child.stdin.write("after-pause")
              await echoed.promise
              const entries = []
              for await (const entry of EnvironmentExecution.environmentEntries(environment.id)) entries.push(entry)
              expect(entries).toHaveLength(1)
              expect(entries[0]!.origin).toEqual({ kind: "host", owner: "lsp", invocationID: entries[0]!.id })
              expect(entries[0]!.workspaces ?? []).toEqual([])
              const marker = path.join(directory.path, "forbidden-server")
              await expect(
                LSPProcess.start(
                  {
                    command: process.execPath,
                    args: ["-e", "await Bun.write(process.argv[1], 'bad')", marker],
                    cwd: directory.path,
                  },
                  AbortSignal.timeout(10000),
                ),
              ).rejects.toThrow("native effect")
              expect(await Bun.file(marker).exists()).toBe(false)
              expect(output).toContain("after-pause")
            } finally {
              await owned.stop()
            }
          })
        }),
    })
  })
}, 20000)

test("language-server preparation retains its original command and environment across native admission", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        lsp().register()
      },
    },
  })
  await runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: () =>
        WorkspaceAccess.withinTask(async () => {
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const provider = EnvironmentProviders.get("native")
          const connect = provider.connect!
          const held = spyOn(provider, "connect").mockImplementationOnce(async (...args) => {
            const executor = await connect(...args)
            entered.resolve()
            await release.promise
            return executor
          })
          const marker = path.join(directory.path, "original")
          const replacement = path.join(directory.path, "replacement")
          const command = {
            command: process.execPath,
            args: ["-e", "await Bun.write(process.argv[1], process.env.ORIGIN_FIXTURE || '')", marker],
            cwd: directory.path,
            env: { ORIGIN_FIXTURE: "original" },
          }
          const pending = LSPProcess.start(command, AbortSignal.timeout(10000))
          void pending.catch(() => {})
          let owned: Awaited<typeof pending> | undefined
          try {
            await entered.promise
            command.args[2] = replacement
            command.env.ORIGIN_FIXTURE = "replacement"
            release.resolve()
            owned = await pending
            owned.child.stdout.resume()
            owned.child.stderr.resume()
            await owned.activate()
            owned.child.stdin.end()
            await owned.completion
            expect(owned.child.exitCode).toBe(0)
            expect(await Bun.file(marker).exists()).toBe(true)
            expect(await Bun.file(marker).text()).toBe("original")
            expect(await Bun.file(replacement).exists()).toBe(false)
          } finally {
            release.resolve()
            held.mockRestore()
            await owned?.stop()
            if (!owned)
              await pending.then(
                (value) => value.stop(),
                () => {},
              )
          }
        }),
    })
  })
}, 20000)

test("language server launch refuses an origin-less selected frame before native process admission", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        lsp().register()
      },
    },
  })
  await runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const marker = path.join(directory.path, "forbidden")
        const release = async () => {}
        await expect(
          EnvironmentResources.provide(
            { kind: "none", release, [Symbol.asyncDispose]: release },
            "missing-origin",
            () =>
              LSPProcess.start(
                {
                  command: process.execPath,
                  args: ["-e", "await Bun.write(process.argv[1], 'bad')", marker],
                  cwd: directory.path,
                },
                AbortSignal.timeout(10000),
              ),
          ),
        ).rejects.toThrow()
        expect(await Bun.file(marker).exists()).toBe(false)
        expect(await Environment.list(ScopeContext.current.scope.id)).toEqual([])
      },
    })
  })
}, 20000)

test("a Task paused while native language-server resources are preparing cannot receive a new Host process", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        lsp().register()
      },
    },
  })
  await runtime.run(async () => {
    await using directory = await tmpdir()
    const scope = await directory.scope()
    await ScopeContext.provide({
      scope,
      fn: () =>
        WorkspaceAccess.withinTask(async () => {
          const environment = await Environment.bind({
            scopeID: scope.id,
            ownerID: "lsp-race",
            provider: "native",
            spec: {},
          })
          const task = await nativeTask(environment.id)
          await using resources = await EnvironmentResources.resolve({
            scopeID: scope.id,
            environmentID: environment.id,
            origin: task.origin,
            needs: { execution: "exec" },
          })
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const provider = EnvironmentProviders.get("native")
          const connect = provider.connect!
          const held = spyOn(provider, "connect").mockImplementationOnce(async (...args) => {
            const executor = await connect(...args)
            entered.resolve()
            await release.promise
            return executor
          })
          const marker = path.join(directory.path, "late-language-server")
          const pending = EnvironmentResources.provide(resources, "preparing", () =>
            LSPProcess.start(
              {
                command: process.execPath,
                args: ["-e", "await Bun.write(process.argv[1], 'bad')", marker],
                cwd: directory.path,
              },
              AbortSignal.timeout(10000),
            ),
          ).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          try {
            await entered.promise
            await SessionLifecycle.pause({ sessionID: task.session.id, reason: "interrupted" })
            release.resolve()
            const result = await pending
            if ("value" in result) {
              result.value.child.stdout.resume()
              result.value.child.stderr.resume()
              try {
                await result.value.activate()
                result.value.child.stdin.end()
                await result.value.completion
              } finally {
                await result.value.stop()
              }
            }
            expect({ admitted: "value" in result, executed: await Bun.file(marker).exists() }).toEqual({
              admitted: false,
              executed: false,
            })
            const active = []
            for await (const entry of EnvironmentExecution.environmentEntries(environment.id)) active.push(entry)
            expect(active).toEqual([])
          } finally {
            release.resolve()
            held.mockRestore()
            const result = await pending
            if ("value" in result) await result.value.stop()
          }
        }),
    })
  })
}, 20000)

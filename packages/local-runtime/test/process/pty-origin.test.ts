import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
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
import { Pty } from "../../src/process/pty"

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
  await RolloutLedger.beginTool({ owner, runID: rootID, messageID, toolCallID: "terminal", tool: "terminal", args: {} })
  return {
    session,
    origin: EnvironmentOrigin.selected({
      kind: "session",
      scopeID: session.scope.id,
      sessionID: session.id,
      rootID,
      runID: rootID,
      messageID,
      callID: "terminal",
      tool: "terminal",
    }),
  }
}

test.skipIf(process.platform === "win32")(
  "a human terminal retains its Host ownership after the originating Task pauses and refuses a new launch from that stale Task",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using directory = await tmpdir()
      const scope = await directory.scope()
      await ScopeContext.provide({
        scope,
        fn: () =>
          WorkspaceAccess.withinTask(async () => {
            const environment = await Environment.bind({
              scopeID: scope.id,
              ownerID: "pty-fixture",
              provider: "native",
              spec: {},
            })
            const task = await nativeTask(environment.id)
            await using resources = await EnvironmentResources.resolve({
              scopeID: scope.id,
              environmentID: environment.id,
              origin: task.origin,
              needs: { execution: "pty" },
            })
            await EnvironmentResources.provide(resources, "terminal-launch", async () => {
              const info = await Pty.create({
                command: process.execPath,
                args: [
                  "-e",
                  "process.stdout.write('ready');process.stdin.on('data', data => process.stdout.write('ECHO:'+data))",
                ],
                cwd: directory.path,
              })
              let output = ""
              const ready = Promise.withResolvers<void>()
              const echoed = Promise.withResolvers<void>()
              Pty.connect(info.id, {
                readyState: 1,
                send(value) {
                  output += value
                  if (output.includes("ready")) ready.resolve()
                  if (output.includes("ECHO:after-pause")) echoed.resolve()
                },
                close() {},
              })
              try {
                await ready.promise
                await SessionLifecycle.pause({ sessionID: task.session.id, reason: "interrupted" })
                await EnvironmentExecution.assertSessionDrained(scope.id, task.session.id, environment.id)
                Pty.write(info.id, "after-pause\n")
                await echoed.promise
                expect(Pty.get(info.id)?.status).toBe("running")
                const entries = []
                for await (const entry of EnvironmentExecution.environmentEntries(environment.id)) entries.push(entry)
                expect(entries).toHaveLength(1)
                expect(entries[0]!.origin).toEqual({ kind: "host", owner: "pty", invocationID: info.id })
                const marker = path.join(directory.path, "forbidden-terminal")
                await expect(
                  Pty.create({
                    command: process.execPath,
                    args: ["-e", "await Bun.write(process.argv[1], 'bad')", marker],
                  }),
                ).rejects.toThrow("native effect")
                expect(await Bun.file(marker).exists()).toBe(false)
              } finally {
                await Pty.remove(info.id)
              }
            })
          }),
      })
    })
  },
  20000,
)

test.skipIf(process.platform === "win32")(
  "terminal creation snapshots its displayed Session and native command before the first Session read waits",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        fn: async () => {
          const session = await Session.create()
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const get = Session.get
          const held = spyOn(Session, "get").mockImplementationOnce(
            Object.assign(
              async (input: string) => {
                const value = await get(input)
                entered.resolve()
                await release.promise
                return value
              },
              { force: get.force, schema: get.schema },
            ),
          )
          const marker = path.join(directory.path, "original")
          const replacement = path.join(directory.path, "replacement")
          const input = {
            sessionID: session.id,
            command: process.execPath,
            args: [
              "-e",
              "await Bun.write(process.argv[1], process.env.ORIGIN_FIXTURE || '');process.stdin.resume()",
              marker,
            ],
            env: { ORIGIN_FIXTURE: "original" },
          }
          const pending = Pty.create(input, AbortSignal.timeout(10000))
          void pending.catch(() => {})
          let info: Pty.Info | undefined
          try {
            await entered.promise
            input.sessionID = Identifier.ascending("session")
            input.args[2] = replacement
            input.env.ORIGIN_FIXTURE = "replacement"
            release.resolve()
            info = await pending
            const deadline = Date.now() + 10000
            while (!(await Bun.file(marker).exists()) && !(await Bun.file(replacement).exists())) {
              if (Date.now() >= deadline) throw new Error("Terminal did not write its marker")
              await Bun.sleep(5)
            }
            expect(info.sessionID).toBe(session.id)
            expect(await Bun.file(marker).exists()).toBe(true)
            expect(await Bun.file(marker).text()).toBe("original")
            expect(await Bun.file(replacement).exists()).toBe(false)
          } finally {
            release.resolve()
            held.mockRestore()
            if (info) await Pty.remove(info.id)
            else
              await pending.then(
                (value) => Pty.remove(value.id),
                () => {},
              )
          }
        },
      })
    })
  },
  20000,
)

test.skipIf(process.platform === "win32")(
  "a Task paused during terminal resource preparation cannot obtain a new Host terminal",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using directory = await tmpdir()
      const scope = await directory.scope()
      await ScopeContext.provide({
        scope,
        fn: () =>
          WorkspaceAccess.withinTask(async () => {
            const environment = await Environment.bind({
              scopeID: scope.id,
              ownerID: "pty-race",
              provider: "native",
              spec: {},
            })
            const task = await nativeTask(environment.id)
            await using resources = await EnvironmentResources.resolve({
              scopeID: scope.id,
              environmentID: environment.id,
              origin: task.origin,
              needs: { execution: "pty" },
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
            const marker = path.join(directory.path, "late-terminal")
            const pending = EnvironmentResources.provide(resources, "preparing", () =>
              Pty.create({
                command: process.execPath,
                args: ["-e", "await Bun.write(process.argv[1], 'bad');process.stdin.resume()", marker],
              }),
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
                const deadline = Date.now() + 10000
                while (!(await Bun.file(marker).exists())) {
                  if (Date.now() >= deadline) throw new Error("Admitted terminal did not start")
                  await Bun.sleep(5)
                }
                await Pty.remove(result.value.id)
              }
              expect({ admitted: "value" in result, executed: await Bun.file(marker).exists() }).toEqual({
                admitted: false,
                executed: false,
              })
              expect(Pty.list()).toEqual([])
            } finally {
              release.resolve()
              held.mockRestore()
              const result = await pending
              if ("value" in result) await Pty.remove(result.value.id)
            }
          }),
      })
    })
  },
  20000,
)

test("terminal creation cannot turn origin-less resources into a fresh Host admission", async () => {
  await using runtime = await testRuntime()
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
              Pty.create({
                command: process.execPath,
                args: ["-e", "await Bun.write(process.argv[1], 'bad')", marker],
              }),
          ),
        ).rejects.toThrow()
        expect(await Bun.file(marker).exists()).toBe(false)
        expect(Pty.list()).toEqual([])
        expect(await Environment.list(ScopeContext.current.scope.id)).toEqual([])
      },
    })
  })
}, 20000)

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
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { formatter } from "../../src/component"
import { FormatterProcess } from "../../src/process"

for (const inherited of [false, true])
  test(`formatter records its ${inherited ? "inherited" : "component"} origin while executing actual native work`, async () => {
    let host: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
    await using runtime = await testRuntime({
      composition: {
        register() {
          registerLocalRuntime({
            workspaceCoordinator: new WorkspaceCoordinator({
              directory: path.join(RuntimeContext.current().host.root, "claims"),
            }),
          })
          formatter().register()
          host = EnvironmentOrigin.registerHost("format-fixture")
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
            if (!host) throw new Error("Fixture Host was not registered")
            const environment = await Environment.bind({
              scopeID: scope.id,
              ownerID: "format-fixture",
              provider: "native",
              spec: {},
            })
            await using resources = await EnvironmentResources.resolve({
              scopeID: scope.id,
              environmentID: environment.id,
              origin: host.capture("original-request"),
              needs: { execution: "exec" },
            })
            const marker = path.join(directory.path, "formatted")
            const release = path.join(directory.path, "release")
            const run = () =>
              FormatterProcess.run({
                command: [
                  process.execPath,
                  "-e",
                  "await Bun.write(process.argv[1], 'formatted');while(!await Bun.file(process.argv[2]).exists())await Bun.sleep(5);process.stdout.write('finished')",
                  marker,
                  release,
                ],
              })
            const pending = inherited ? EnvironmentResources.provide(resources, "selected", run) : run()
            void pending.catch(() => {})
            try {
              const deadline = Date.now() + 10000
              while (!(await Bun.file(marker).exists())) {
                if (Date.now() >= deadline) throw new Error("Formatter did not start")
                await Bun.sleep(5)
              }
              const entries = []
              for (const selected of await Environment.list(scope.id))
                for await (const entry of EnvironmentExecution.environmentEntries(selected.id)) entries.push(entry)
              expect(entries).toHaveLength(1)
              expect(entries[0]!.origin).toMatchObject(
                inherited
                  ? { kind: "host", owner: "format-fixture", invocationID: "original-request" }
                  : { kind: "host", owner: "formatter", invocationID: entries[0]!.id },
              )
              if (inherited) expect(entries[0]!.workspaces ?? []).toEqual([])
              await Bun.write(release, "go")
              expect(await pending).toEqual({ exitCode: 0, stdout: "finished" })
              expect(await Bun.file(marker).text()).toBe("formatted")
              expect((await EnvironmentExecution.get(entries[0]!.id, scope.id)).origin).toEqual(entries[0]!.origin)
            } finally {
              await Bun.write(release, "go")
              await pending.catch(() => {})
            }
          }),
      })
    })
  }, 20000)

test("formatter cannot replace an origin-less selected resource frame with its own Host admission", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        formatter().register()
      },
    },
  })
  await runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const marker = path.join(directory.path, "unauthorized")
        const release = async () => {}
        await expect(
          EnvironmentResources.provide(
            { kind: "none", release, [Symbol.asyncDispose]: release },
            "missing-origin",
            () =>
              FormatterProcess.run({
                command: [process.execPath, "-e", "await Bun.write(process.argv[1], 'bad')", marker],
              }),
          ),
        ).rejects.toThrow()
        expect(await Bun.file(marker).exists()).toBe(false)
        expect(await Environment.list(ScopeContext.current.scope.id)).toEqual([])
      },
    })
  })
}, 20000)

test("formatter snapshots its command and environment before native preparation waits", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        formatter().register()
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
          const input = {
            command: [
              process.execPath,
              "-e",
              "await Bun.write(process.argv[1], process.env.ORIGIN_FIXTURE || '')",
              marker,
            ],
            environment: { ORIGIN_FIXTURE: "original" },
          }
          const pending = FormatterProcess.run(input)
          void pending.catch(() => {})
          try {
            await entered.promise
            input.command[3] = replacement
            input.environment.ORIGIN_FIXTURE = "replacement"
            release.resolve()
            expect((await pending)?.exitCode).toBe(0)
            expect(await Bun.file(marker).exists()).toBe(true)
            expect(await Bun.file(marker).text()).toBe("original")
            expect(await Bun.file(replacement).exists()).toBe(false)
          } finally {
            release.resolve()
            held.mockRestore()
            await pending.catch(() => {})
          }
        }),
    })
  })
}, 20000)

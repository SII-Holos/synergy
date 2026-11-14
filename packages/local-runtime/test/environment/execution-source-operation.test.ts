import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentExecutionSource as Source } from "@ericsanchezok/synergy-harness/environment/execution-source"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeResources } from "@ericsanchezok/synergy-harness/resources/runtime"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { testEnvironmentRuntime } from "@ericsanchezok/synergy-harness/test/support/environment-origin"
import { testRuntime } from "../support/runtime"

function observed(info: EnvironmentExecution.Info) {
  const raw: unknown = JSON.parse(JSON.stringify(info))
  return EnvironmentExecution.Info.parse({ ...info, sourceObservation: JsonValue.parse(raw) })
}

for (const mode of ["natural", "accepted-cancel"] as const)
  test.skipIf(process.platform === "win32")(
    mode === "natural"
      ? "an accepted source operation drains its real command after its public admission lease retires"
      : "an accepted cancellation keeps its original owner while completed storage seals new controls",
    async () => {
      await using physical = await testEnvironmentRuntime({}, testRuntime)
      const scopeID = "source-operation-scope",
        id = "original-source-command"
      const environment = await physical.run(() =>
        Environment.bind({
          scopeID,
          ownerID: "physical-operation-owner",
          provider: "native",
          spec: {},
        }),
      )
      const origin = await physical.run(() => EnvironmentOrigin.selected(physical.origin("source-operation")))
      const physicalOwner = await physical.run(() => RuntimeContext.current())
      const publishRunning = Promise.withResolvers<void>()
      const reserve = RuntimeResources.reserve
      let admissionHeld = false
      let admissionReadyObserved = false
      using admission = spyOn(RuntimeResources, "reserve").mockImplementation(async (request) => {
        const lease = await reserve(request)
        if (
          mode !== "natural" ||
          admissionHeld ||
          RuntimeContext.current() !== physicalOwner ||
          request.owner !== environment.id
        )
          return lease
        admissionHeld = true
        const release = lease.release.bind(lease)
        lease.release = async () => {
          await publishRunning.promise
          await release()
        }
        return lease
      })
      let opens = 0,
        starts = 0,
        cancellations = 0
      const cancelled = Promise.withResolvers<void>(),
        reply = Promise.withResolvers<void>()
      async function nativeInfo() {
        return physical.run(async () => {
          try {
            return await EnvironmentExecution.reconcile(id, scopeID)
          } catch (error) {
            if (error instanceof Storage.NotFoundError) return
            throw error
          }
        })
      }
      async function drain(cancel = true) {
        let info = await nativeInfo()
        if (!info || info.state === "completed") return
        if (cancel && (!info.status || !ExecutionProtocol.terminal(info.status)))
          await physical.run(() => EnvironmentExecution.cancel(id, scopeID))
        const signal = AbortSignal.timeout(5000)
        for (;;) {
          signal.throwIfAborted()
          info = await nativeInfo()
          if (!info) throw new Error("An original physical operation lost its native receipt")
          if (info.status && ExecutionProtocol.terminal(info.status)) {
            await physical.run(() => EnvironmentExecution.complete(id, scopeID))
            return
          }
          const current = info,
            status = info.status
          if (status)
            await physical.run(async () => {
              const executor = await EnvironmentExecution.connect(current)
              await executor.waitForChange?.(id, status, 250)
            })
        }
      }
      await using controller = await testEnvironmentRuntime(
        {
          register() {
            Source.register("native-operation-test", {
              async open(input) {
                opens++
                return physical.run(async () => {
                  const use = await Environment.acquire(environment.id, {
                    scopeID,
                    useID: "source-admission",
                    capabilities: ["exec"],
                    ownership: origin,
                  })
                  const executor = await EnvironmentExecution.connect({ scopeID, target: use.target })
                  if (!executor.describe) throw new Error("The actual Native Executor has no description")
                  const runtime = await executor.describe()
                  await Bun.write(path.join(runtime.directory, "seed.bin"), new Uint8Array([0, 255, 37, 128]))
                  const bind = physical.bind
                  const opened: Source.Opened = {
                    target: use.target,
                    runtime,
                    directory: runtime.directory,
                    binding: { environmentID: environment.id },
                    workspaces: [],
                    useRoots: [runtime.directory],
                    assert: input.origin.assertCurrent,
                    release: bind(use.release),
                    executor: {
                      describe: bind(executor.describe.bind(executor)),
                      ...(executor.prepareInputs && { prepareInputs: bind(executor.prepareInputs.bind(executor)) }),
                      ...(executor.discardInputs && { discardInputs: bind(executor.discardInputs.bind(executor)) }),
                      start: bind(executor.start.bind(executor)),
                      status: bind(executor.status.bind(executor)),
                      output: bind(executor.output.bind(executor)),
                      stdin: bind(executor.stdin.bind(executor)),
                      resize: bind(executor.resize.bind(executor)),
                      cancel: bind(executor.cancel.bind(executor)),
                      release: bind(executor.release.bind(executor)),
                    },
                    operations: {
                      async start(value) {
                        starts++
                        return observed(
                          await physical.run(() =>
                            EnvironmentExecution.start({
                              id: value.id,
                              scopeID: value.scopeID,
                              command: value.command,
                              workspaces: value.workspaces,
                              intentDigest: value.intentDigest,
                              signal: value.signal,
                              environmentID: environment.id,
                              origin,
                            }),
                          ),
                        )
                      },
                      async inspect(operationID) {
                        return observed(await physical.run(() => EnvironmentExecution.reconcile(operationID, scopeID)))
                      },
                      output: bind((operationID: string, after: number, limit: number) =>
                        EnvironmentExecution.output(operationID, scopeID, after, limit),
                      ),
                      async complete(operationID) {
                        return observed(await physical.run(() => EnvironmentExecution.complete(operationID, scopeID)))
                      },
                      async cancel(operationID) {
                        cancellations++
                        await physical.run(() => EnvironmentExecution.cancel(operationID, scopeID))
                        if (mode === "accepted-cancel") {
                          cancelled.resolve()
                          await reply.promise
                        }
                      },
                      stdin: bind((operationID: string, bytes: Uint8Array, end: boolean) =>
                        EnvironmentExecution.stdin(operationID, scopeID, bytes, end),
                      ),
                      resize: bind((operationID: string, cols: number, rows: number) =>
                        EnvironmentExecution.resize(operationID, scopeID, cols, rows),
                      ),
                    },
                  }
                  return opened
                })
              },
              async inspect(input) {
                return {
                  info: await nativeInfo().then((info) => info && observed(info)),
                  output: await physical.run(() => EnvironmentExecution.output(id, scopeID, input.after, input.limit)),
                }
              },
              async close() {
                if (!(await nativeInfo())) return
                await drain()
                await EnvironmentExecution.reconcile(id, scopeID)
                await EnvironmentExecution.complete(id, scopeID)
              },
            })
          },
        },
        testRuntime,
      )
      const errors: unknown[] = []
      try {
        await controller.run(async () => {
          const selected = EnvironmentOrigin.selected(controller.origin("source-operation"))
          const lease = await Source.open({
            selection: { scopeID, ownerID: "controller-owner", environmentID: environment.id },
            needs: { execution: "exec" },
            origin: selected,
          })
          if (!lease) throw new Error("The registered Native source did not return its genuine lease")
          const command = ExecutionProtocol.Command.parse({
            command: process.execPath,
            args: [
              "-e",
              [
                "if (new Uint8Array(await Bun.file('seed.bin').arrayBuffer()).join(',') !== '0,255,37,128') throw new Error('Wrong bytes');",
                "process.stdout.write('SOURCE_OPERATION_READY\\n');",
                "const input = await new Promise(resolve => process.stdin.once('data', resolve));",
                "if (Buffer.from(input).toString() !== 'finish\\n') throw new Error('Unexpected original operation input');",
                "process.stdin.destroy();",
                "process.stdout.write('SOURCE_OPERATION_FINISHED\\n');",
              ].join("\n"),
            ],
            cwd: lease.directory,
            env: {},
            useRoots: [...lease.useRoots],
          })
          const submitted = await EnvironmentExecution.start({
            id,
            scopeID,
            environmentID: environment.id,
            command,
            origin: selected,
            source: lease,
          })
          const original = await Source.retainOperation(lease, {
            id,
            scopeID,
            digest: submitted.digest,
            origin: selected,
          })
          await expect(
            Source.retainOperation(lease, { id, scopeID, digest: "a".repeat(64), origin: selected }),
          ).rejects.toThrow("committed native submission")
          await expect(
            physical.run(() =>
              Source.retainOperation(lease, { id, scopeID, digest: submitted.digest, origin: selected }),
            ),
          ).rejects.toThrow("original Runtime")
          await expect(original.stdin("another-command", new Uint8Array([1]), false)).rejects.toThrow("native identity")
          await expect(original.close()).rejects.toThrow("completion is not committed")
          const signal = AbortSignal.timeout(5000)
          for (;;) {
            signal.throwIfAborted()
            const info = await EnvironmentExecution.reconcile(id, scopeID)
            const output = await EnvironmentExecution.output(id, scopeID)
            if (
              info.state === "running" &&
              info.status?.state === "running" &&
              output.some((chunk) => Buffer.from(chunk.data, "base64").toString().includes("SOURCE_OPERATION_READY"))
            )
              break
            if (info.status && ExecutionProtocol.terminal(info.status))
              throw new Error("The real command ended before its ready barrier")
            if (
              mode === "natural" &&
              info.status?.state === "accepted" &&
              output.some((chunk) => Buffer.from(chunk.data, "base64").toString().includes("SOURCE_OPERATION_READY"))
            ) {
              admissionReadyObserved = true
              publishRunning.resolve()
            }
            const status = info.status
            if (status)
              await physical.run(async () => {
                const original = await EnvironmentExecution.get(id, scopeID)
                const executor = await EnvironmentExecution.connect(original)
                await executor.waitForChange?.(id, status, 250)
              })
          }
          expect(starts).toBe(1)
          expect(await nativeInfo()).toMatchObject({ state: "running", status: { state: "running" } })
          await lease.release()
          await expect(
            Source.retainOperation(lease, { id, scopeID, digest: submitted.digest, origin: selected }),
          ).rejects.toThrow("lease has ended")
          const uses = await physical.run(() => Environment.uses(environment.id))
          expect(uses.some((use) => use.kind === "admission")).toBe(false)
          expect(uses.some((use) => use.kind === "operation" && use.ownership.kind === "execution")).toBe(true)
          const ordinary = Source.operations(lease)
          await expect(ordinary.stdin(id, new Uint8Array([1]), false)).rejects.toThrow("lease has ended")
          await expect(
            ordinary.start({
              id: "another-command",
              scopeID,
              command,
              digest: ExecutionProtocol.digest(command),
              origin: selected,
            }),
          ).rejects.toThrow("lease has ended")
          if (!lease.executor.prepareInputs) throw new Error("Native source did not expose its original input owner")
          await expect(
            lease.executor.prepareInputs({ id: "late-input", files: [{ name: "late.bin", data: "AA==" }] }),
          ).rejects.toThrow("lease has ended")
          if (mode === "natural") {
            {
              const controllerStore = Storage.current().store
              const get = EnvironmentExecution.get
              let reads = 0
              let canonical:
                | {
                    state: EnvironmentExecution.Info["state"]
                    status?: ExecutionProtocol.Status
                  }
                | undefined
              using guardRead = spyOn(EnvironmentExecution, "get").mockImplementation(async (...args) => {
                const info = await get(...args)
                if (args[0] === id && args[1] === scopeID && Storage.current().store === controllerStore) {
                  reads++
                  canonical = { state: info.state, status: info.status && structuredClone(info.status) }
                }
                return info
              })
              try {
                await EnvironmentExecution.stdin(id, scopeID, new TextEncoder().encode("finish\n"))
              } catch (error) {
                console.error(
                  "SOURCE_OPERATION_STDIN_GUARD",
                  JSON.stringify({
                    reads,
                    state: canonical?.state,
                    status: canonical?.status?.state,
                    effectsStarted: canonical?.status?.effectsStarted,
                    exitCode: canonical?.status?.exitCode,
                    signal: canonical?.status?.signal,
                    treeDrained: canonical?.status?.treeDrained,
                    streamsDrained: canonical?.status?.streamsDrained,
                    cursor: canonical?.status?.cursor,
                  }),
                )
                throw error
              }
            }
            expect(admissionHeld).toBe(true)
            expect(admissionReadyObserved).toBe(true)
            await drain(false)
            const result = await EnvironmentExecution.reconcile(id, scopeID)
            expect(result.status).toMatchObject({
              state: "exited",
              exitCode: 0,
              treeDrained: true,
              streamsDrained: true,
            })
            expect((await EnvironmentExecution.complete(id, scopeID)).state).toBe("completed")
          } else {
            const cancellation = original.cancel(id, submitted.digest)
            const outcome = cancellation.then(
              () => ({ state: "complete" as const }),
              (error) => ({ state: "failed" as const, error }),
            )
            try {
              await cancelled.promise
              await drain(false)
              const terminal = await EnvironmentExecution.reconcile(id, scopeID)
              expect(terminal.status).toMatchObject({ state: "cancelled", treeDrained: true, streamsDrained: true })
              expect((await EnvironmentExecution.complete(id, scopeID)).state).toBe("completed")
              expect(Source.hasPendingRequests()).toBe(true)
              await expect(original.stdin(id, new Uint8Array([1]), false)).rejects.toThrow("has settled")
              await expect(original.cancel(id, submitted.digest)).rejects.toThrow("has settled")
              expect(cancellations).toBe(1)
              reply.resolve()
              const result = await outcome
              if (result.state === "failed") throw result.error
              expect(Source.hasPendingRequests()).toBe(false)
              expect(cancellations).toBe(1)
            } finally {
              reply.resolve()
              await outcome
            }
          }
          await expect(original.stdin(id, new Uint8Array([1]), false)).rejects.toThrow("has settled")
          expect(await physical.run(() => Environment.uses(environment.id))).toEqual([])
          expect(opens).toBe(1)
          expect(starts).toBe(1)
        })
      } catch (error) {
        errors.push(error)
      }
      publishRunning.resolve()
      try {
        await controller.run(() => Source.close())
      } catch (error) {
        errors.push(error)
      }
      try {
        await drain()
        await physical.run(() => Environment.deallocate(environment.id, { scopeID }))
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Original operation continuation and native cleanup failed")
    },
    15000,
  )

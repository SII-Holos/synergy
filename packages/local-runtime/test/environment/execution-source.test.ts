import { expect, test } from "bun:test"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentExecutionSource as Source } from "@ericsanchezok/synergy-harness/environment/execution-source"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { testEnvironmentRuntime } from "@ericsanchezok/synergy-harness/test/support/environment-origin"
import { testRuntime } from "../support/runtime"

async function fixture(
  hooks: {
    opened?(): Promise<void>
    released?(): Promise<void>
    close?(): Promise<void>
    prepared?(value: ExecutionProtocol.PreparedInputs): Promise<void>
    releaseStarted?(value: Promise<void>): void
    read?(operation: "retained-inspect" | "live-inspect" | "live-output"): void
    selected?: NonNullable<Source.Port["selected"]>
    opening?(): void
  } = {},
) {
  const releases: Array<() => Promise<void>> = []
  const inputs: Array<() => Promise<void>> = []
  const runtime = await testEnvironmentRuntime(
    {
      register() {
        Source.register("native-fixture", {
          selected: hooks.selected,
          async open(input) {
            hooks.opening?.()
            const scopeID = input.selection.scopeID
            const environmentID = input.selection.environmentID
            if (!environmentID) return
            const use = await Environment.acquire(environmentID, {
              scopeID,
              useID: `fixture:${crypto.randomUUID()}`,
              capabilities: [input.needs.execution],
              ownership: input.origin,
            })
            releases.push(use.release)
            try {
              const environment = await Environment.assertTarget(use.target, scopeID)
              const executor = await EnvironmentProviders.get(environment.provider).connect?.(
                Environment.requestOf(environment),
                use.target,
              )
              if (!executor?.describe) throw new Error("Native fixture requires its real Executor")
              const description = await executor.describe()
              if (hooks.prepared && executor.prepareInputs) {
                const prepare = executor.prepareInputs.bind(executor)
                const discard = executor.discardInputs?.bind(executor)
                executor.prepareInputs = async (input) => {
                  if (discard) inputs.push(() => discard(input.id))
                  const value = await prepare(input)
                  await hooks.prepared?.(value)
                  return value
                }
              }
              await hooks.opened?.()
              return {
                target: use.target,
                runtime: description,
                directory: description.directory,
                binding: { environmentID },
                executor,
                workspaces: [],
                useRoots: [description.directory],
                assert: input.origin.assertCurrent,
                async release() {
                  const pending = use.release()
                  hooks.releaseStarted?.(pending)
                  await pending
                  await hooks.released?.()
                },
                operations: {
                  start: (value) => EnvironmentExecution.start({ ...value, environmentID }),
                  inspect: (id) => {
                    hooks.read?.("live-inspect")
                    return EnvironmentExecution.get(id, scopeID)
                  },
                  output: (id, after, limit) => {
                    hooks.read?.("live-output")
                    return EnvironmentExecution.output(id, scopeID, after, limit)
                  },
                  complete: (id) => EnvironmentExecution.complete(id, scopeID),
                  cancel: (id) => EnvironmentExecution.cancel(id, scopeID),
                  stdin: (id, data, end) => EnvironmentExecution.stdin(id, scopeID, data, end),
                  resize: (id, cols, rows) => EnvironmentExecution.resize(id, scopeID, cols, rows),
                },
              }
            } catch (error) {
              await use.release()
              throw error
            }
          },
          async inspect(input) {
            hooks.read?.("retained-inspect")
            await Environment.assertTarget(input.target, input.scopeID)
            return { info: undefined, output: [] }
          },
          close: hooks.close,
        })
      },
    },
    testRuntime,
  )
  return {
    runtime,
    async run(body: (input: Source.Input, environment: Environment.Info) => Promise<void>) {
      await runtime.run(async () => {
        const environment = await Environment.bind({
          scopeID: "source-scope",
          ownerID: "owner",
          provider: "native",
          spec: {},
        })
        const input = {
          selection: { scopeID: environment.scopeID, ownerID: "owner", environmentID: environment.id },
          needs: { execution: "exec" as const },
          origin: EnvironmentOrigin.selected(runtime.origin("source-request")),
        }
        try {
          await body(input, environment)
        } finally {
          await Source.close().catch(() => {})
          for (const release of releases) await release()
          for (const discard of inputs) await discard()
          await Environment.deallocate(environment.id, { scopeID: environment.scopeID })
        }
      })
    },
    [Symbol.asyncDispose]: runtime.close,
  }
}

test("execution source retains a held real admission when its primary changes before open returns", async () => {
  const opened = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>()
  await using context = await fixture({
    async opened() {
      opened.resolve()
      await resume.promise
    },
  })
  await context.run(async (input, environment) => {
    const runtime = RuntimeContext.current(),
      primary = runtime.storage
    const pending = Source.open(input)
    const observed = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await opened.promise
    expect(await Environment.uses(environment.id)).toHaveLength(1)
    try {
      runtime.storage = undefined
      resume.resolve()
      expect(await observed).toBeInstanceOf(Error)
    } finally {
      runtime.storage = primary
      resume.resolve()
    }
    await Source.close()
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
})

test("releasing an execution lease waits for its accepted native input preparation", async () => {
  const entered = Promise.withResolvers<ExecutionProtocol.PreparedInputs>(),
    resume = Promise.withResolvers<void>()
  let finished = false
  let originalRelease: Promise<void> | undefined
  const releases: boolean[] = []
  await using context = await fixture({
    async prepared(value) {
      entered.resolve(value)
      await resume.promise
      finished = true
    },
    async released() {
      releases.push(finished)
    },
    releaseStarted(value) {
      originalRelease = value
    },
  })
  await context.run(async (input, environment) => {
    const lease = await Source.open(input)
    if (!lease?.executor.prepareInputs) throw new Error("Native source has no actual input preparation")
    const pending = lease.executor.prepareInputs({ id: "held-input", files: [{ name: "bytes.bin", data: "AP+A" }] })
    const prepared = pending.then(
      (value) => value,
      () => undefined,
    )
    const value = await entered.promise
    expect(new Uint8Array(await Bun.file(value.paths["bytes.bin"]).arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 128]),
    )
    const release = lease.release()
    const released = release.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await Promise.resolve()
      if (originalRelease) await originalRelease
      expect(await Environment.uses(environment.id)).toHaveLength(1)
      expect(releases).toEqual([])
    } finally {
      resume.resolve()
    }
    await prepared
    expect(await released).toBeUndefined()
    expect(releases).toEqual([true])
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
})

test("execution source close drains the entire held open pipeline and its real Use", async () => {
  const opened = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>()
  let closeCalls = 0
  await using context = await fixture({
    async opened() {
      opened.resolve()
      await resume.promise
    },
    async close() {
      closeCalls++
    },
  })
  await context.run(async (input, environment) => {
    const pending = Source.open(input)
    const observed = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await opened.promise
    const closing = Source.close()
    const closed = closing.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(closeCalls).toBe(0)
    expect(await Environment.uses(environment.id)).toHaveLength(1)
    resume.resolve()
    expect(await observed).toMatchObject({ name: "EnvironmentUnavailable" })
    expect(await closed).toBeUndefined()
    expect(await Environment.uses(environment.id)).toHaveLength(0)
    expect(closeCalls).toBe(1)
  })
})

test("execution source retries unknown release and failed close without reopening effects", async () => {
  let releases = 0,
    closes = 0
  await using context = await fixture({
    async released() {
      if (++releases === 1) throw new Error("Release acknowledgement was lost")
    },
    async close() {
      if (++closes === 1) throw new Error("Native source close is unconfirmed")
    },
  })
  await context.run(async (input, environment) => {
    const lease = await Source.open(input)
    if (!lease) throw new Error("Native source did not return its admission")
    const retained = Source.capture(lease, input.origin)
    const operations = Source.operations(lease)
    await expect(lease.release()).rejects.toThrow("acknowledgement was lost")
    expect(await Environment.uses(environment.id)).toHaveLength(0)
    await expect(Source.close()).rejects.toThrow("did not close")
    expect(releases).toBe(2)
    expect(
      await Source.inspect(retained, {
        scopeID: environment.scopeID,
        operationID: "old-operation",
        digest: "a".repeat(64),
        origin: input.origin.value,
      }),
    ).toEqual({ info: undefined, output: [] })
    for (const call of [
      () => operations.stdin("old-operation", new Uint8Array([1]), true),
      () => operations.resize("old-operation", 80, 24),
      () => operations.cancel("old-operation", "a".repeat(64)),
      () => operations.complete("old-operation"),
    ])
      await expect(call()).rejects.toThrow("lease has ended")
    await Source.close()
    expect(closes).toBe(2)
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
})

test("execution source reads never enter their Port inside a native SQL transaction or snapshot", async () => {
  const reads: string[] = []
  await using context = await fixture({
    read(operation) {
      reads.push(operation)
    },
  })
  await context.run(async (input, environment) => {
    const lease = await Source.open(input)
    if (!lease) throw new Error("Native source did not return its admission")
    const retained = Source.capture(lease, input.origin)
    const operations = Source.operations(lease)
    const inspect = () =>
      Source.inspect(retained, {
        scopeID: environment.scopeID,
        operationID: "original-operation",
        digest: "a".repeat(64),
        origin: input.origin.value,
      })
    expect(await inspect()).toEqual({ info: undefined, output: [] })
    expect(reads).toEqual(["retained-inspect"])
    reads.length = 0
    const failures: unknown[] = []
    for (const execute of [Storage.transaction, Storage.snapshot]) {
      await execute(async () => {
        Source.captureOwner(retained)()
      })
      for (const read of [
        inspect,
        () => operations.inspect("original-operation"),
        () => operations.output("original-operation", 0, 1),
      ])
        failures.push(
          await execute(async () => {
            await read()
          }).then(
            () => undefined,
            (error: unknown) => error,
          ),
        )
    }
    expect(await Environment.uses(environment.id)).toHaveLength(1)
    expect(reads).toEqual([])
    expect(failures).toHaveLength(6)
    for (const failure of failures) expect(failure).toMatchObject({ name: "EnvironmentUnavailable" })
    await lease.release()
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
})

test("a readonly actual primary permits retained inspection but cannot enter an execution source producer", async () => {
  await using context = await fixture()
  await context.run(async (input, environment) => {
    const lease = await Source.open(input)
    if (!lease) throw new Error("Native source did not return its original admission")
    const record = Source.capture(lease, input.origin)
    expect(await Environment.uses(environment.id)).toHaveLength(1)
    await lease.release()
    expect(await Environment.uses(environment.id)).toHaveLength(0)
    const primary = Storage.current()
    if (primary.store.options.backend !== "sqlite") throw new Error("Readonly fixture requires its real SQLite primary")
    const options = { ...primary.store.options, readonly: true, mustExist: true }
    const reader = RuntimeContext.create(context.runtime.host, "oneshot")
    let opened = 0,
      inspected = 0
    try {
      await reader.run(async () => {
        const store = await TransactionalStore.open(options)
        reader.storage = {
          store,
          artifactDirectory: primary.artifactDirectory,
          artifactObjects: primary.artifactObjects,
        }
        try {
          const host = EnvironmentOrigin.registerHost("readonly-source")
          Source.register(record.provider, {
            async open() {
              opened++
              return undefined
            },
            async inspect(value) {
              inspected++
              await Environment.assertTarget(value.target, value.scopeID)
              return { info: undefined, output: [] }
            },
          })
          RuntimeContext.sealComposition()
          const origin = EnvironmentOrigin.selected(host.capture("readonly-operation"))
          expect(Storage.current().store).toBe(reader.storage?.store)
          expect(Storage.current().store.options.readonly).toBe(true)
          expect(
            await Source.inspect(record, {
              scopeID: environment.scopeID,
              operationID: "old-operation",
              digest: "a".repeat(64),
              origin: origin.value,
            }),
          ).toEqual({ info: undefined, output: [] })
          expect(inspected).toBe(1)
          const failure = await Source.open({ ...input, origin }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(opened).toBe(0)
          expect(failure).toMatchObject({ name: "EnvironmentUnavailable" })
          expect(await Environment.uses(environment.id)).toHaveLength(0)
        } finally {
          try {
            await Source.close()
          } finally {
            await store.close()
          }
        }
      })
    } finally {
      reader.dispose()
    }
  })
})

test("native-only selection inspects its registered source without opening or allocating its Native provider", async () => {
  let remote = true,
    opened = 0,
    inspected = 0
  await using context = await fixture({
    async selected(selection) {
      inspected++
      expect(Object.isFrozen(selection)).toBe(true)
      return remote
    },
    opening() {
      opened++
    },
  })
  await context.run(async (input, environment) => {
    expect(await Environment.selectNative(input.selection)).toBeUndefined()
    remote = false
    expect((await Environment.selectNative(input.selection))?.id).toBe(environment.id)
    expect(inspected).toBe(2)
    expect(opened).toBe(0)
    expect((await Environment.get(environment.id, environment.scopeID)).state).toBe("idle")
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
})

test("native-only selection cannot treat an unavailable metadata owner as a native fallback", async () => {
  await using context = await fixture()
  await context.run(async (input, environment) => {
    await expect(Environment.selectNative(input.selection)).rejects.toThrow("verify native-only selection")
    expect((await Environment.get(environment.id, environment.scopeID)).state).toBe("idle")
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
})

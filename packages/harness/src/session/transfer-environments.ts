import { z } from "zod"
import { Session } from "."
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { Environment } from "../environment"
import { EnvironmentExecution } from "../environment/execution"
import { EnvironmentProviders } from "../environment/provider"
import { EnvironmentPortableSchema as S } from "../environment/portable-schema"
import { EnvironmentTransferRecords as Records } from "../environment/transfer-records"
import { SessionTransferCore as Core } from "./transfer-core"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import { SessionTransferOwners as Owners } from "./transfer-owners"
import type { SessionTransferStream } from "./transfer-stream"
import { EnvironmentExecutionPortable as Portable } from "../environment/execution-portable"
import { inspectSessionEnvironmentOrigin } from "./environment-origin"
import { StoragePath } from "../storage/path"
import { createHash } from "node:crypto"

export namespace SessionTransferEnvironments {
  export const receipt = Records.receipt
  export interface MappingSource {
    applies(session: Readonly<Session.Info>): boolean
    capture(
      context: Readonly<Owners.SourceContext>,
      selected: Readonly<S.Selection> | null,
    ): { mapping: S.Mapping; assert(): void } | undefined
    target(
      context: Readonly<Owners.TargetContext>,
      source: Readonly<z.infer<typeof S.ExplicitSource>>,
      selected: Readonly<S.Selection> | null,
    ): () => void
  }
  const ownerID = "session-environments"
  const preparations = new WeakMap<Owners.TargetContext, { hash: string; assert(): void }>()
  const mappingSources = RuntimeContext.state(() => new Map<string, MappingSource>())
  const executions = (source: S.Source) => (source.version === 1 ? 0 : source.executions)
  export function registerMappingSource(provider: string, port: MappingSource) {
    RuntimeContext.assertCompositionOpen("Environment transfer mapping sources")
    provider = z.string().min(1).max(4096).parse(provider)
    if (mappingSources().has(provider)) throw new Error("Environment transfer mapping source is already registered")
    mappingSources().set(
      provider,
      Object.freeze({
        applies: port.applies.bind(port),
        capture: port.capture.bind(port),
        target: port.target.bind(port),
      }),
    )
  }
  function explicitMapping(context: Owners.SourceContext, selected: S.Selection | null) {
    let observed: { mapping: S.Mapping; assert(): void } | undefined
    for (const [provider, port] of mappingSources()) {
      if (!port.applies(context.session)) continue
      const result = port.capture(context, selected ? structuredClone(selected) : null)
      if (!result) fail("The selected Environment mapping source has no original capture authority")
      result.assert()
      const mapping = S.Mapping.parse(structuredClone(result.mapping))
      if (mapping.provider !== provider || observed) fail("Environment mapping has an ambiguous registered owner")
      observed = { mapping, assert: result.assert.bind(result) }
    }
    return observed
  }
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  function guard(signal: AbortSignal) {
    const runtime = RuntimeContext.current()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const namespace = JSON.stringify(store.options)
    const blobs = artifactObjects?.blobs
    const writerID = artifactObjects?.writerID
    const now = artifactObjects?.now
    return () => {
      signal.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        JSON.stringify(store.options) !== namespace ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects ||
        artifactObjects?.blobs !== blobs ||
        artifactObjects?.writerID !== writerID ||
        artifactObjects?.now !== now
      )
        fail("Environment transfer belongs to another Runtime or Storage handle")
    }
  }
  async function selection(environmentID: string | null | undefined, scopeID: string): Promise<S.Selection | null> {
    if (!environmentID) return null
    const info = await Environment.get(environmentID, scopeID)
    const provider = EnvironmentProviders.get(info.provider)
    if (!provider.portableDescriptor || info.ownership !== "borrowed")
      fail("Environment requires its registered provider's safe portability descriptor")
    return S.Selection.parse({
      environmentID: info.id,
      provider: info.provider,
      generation: info.generation,
      state: info.state,
      descriptor: provider.portableDescriptor(info.spec),
    })
  }
  export async function nativeSelection(input: {
    environmentID: string | null
    scopeID: string
    signal?: AbortSignal
  }) {
    const assertOwner = guard(input.signal ?? new AbortController().signal)
    const selected = await selection(input.environmentID, input.scopeID)
    assertOwner()
    return selected
  }
  async function historyCount(scopeID: string, sessionID: string, signal: AbortSignal, read = Portable.records) {
    let count = 0
    for await (const { value } of read({ scopeID, sessionID }, signal)) {
      await inspectSessionEnvironmentOrigin(value.execution.origin)
      signal.throwIfAborted()
      count = z
        .number()
        .int()
        .nonnegative()
        .safe()
        .parse(count + 1)
    }
    return count
  }
  function requirement(error: unknown): Owners.Requirement {
    return {
      code: "environment_portability_unavailable",
      owner: ownerID,
      label:
        error instanceof Owners.Rejected
          ? error.data.message
          : "Reconcile the selected Environment's native portability descriptor",
      recoverable: true,
    }
  }
  async function inspect(context: Owners.SourceContext): Promise<Owners.Inspection> {
    context = { ...context, session: structuredClone(context.session) }
    const assertOwner = guard(context.signal)
    const session = await Session.get(context.session.id)
    assertOwner()
    const requirements: Owners.Requirement[] = []
    try {
      await historyCount(session.scope.id, session.id, context.signal, Portable.discoverRecords)
      await selection(session.environmentID, session.scope.id)
    } catch (error) {
      assertOwner()
      requirements.push(requirement(error))
    }
    assertOwner()
    return {
      requirements,
      children: (async function* () {
        yield* []
      })(),
    }
  }
  async function freeze(context: Owners.SourceContext) {
    context = { ...context, session: structuredClone(context.session) }
    const assertOwner = guard(context.signal)
    const binding = await Epochs.ownerPreparationBinding({
      sessionID: context.session.id,
      handoffID: context.handoffID,
    })
    if (
      binding.scopeID !== context.session.scope.id ||
      (binding.rootSessionID ?? binding.sessionID) !== context.rootSessionID
    )
      fail("Environment preparation belongs to another source binding")
    await EnvironmentExecution.drainSession({
      scopeID: binding.scopeID,
      sessionID: binding.sessionID,
      signal: context.signal,
    })
    assertOwner()
    let mapping: ReturnType<typeof explicitMapping>
    await Storage.transaction(
      async () => {
        assertOwner()
        const currentBinding = await Epochs.ownerPreparationBinding({
          sessionID: binding.sessionID,
          handoffID: binding.handoffID,
        })
        if (JSON.stringify(currentBinding) !== JSON.stringify(binding))
          fail("Environment source binding changed during drainage")
        const session = await Session.get(binding.sessionID)
        await EnvironmentExecution.assertSessionDrained(
          session.scope.id,
          session.id,
          session.environmentID,
          session.workspaceID,
        )
        const count = await historyCount(session.scope.id, session.id, context.signal)
        const current = await Environment.binding(session.scope.id, session.id)
        if ((current?.id ?? null) !== session.environmentID)
          fail("Native Environment binding disagrees with its Session")
        const selected = await selection(session.environmentID, session.scope.id)
        mapping = explicitMapping({ ...context, session }, selected)
        mapping?.assert()
        const existing = await Records.source({
          scopeID: session.scope.id,
          sessionID: session.id,
          handoffID: context.handoffID,
        })
        if (existing) {
          if (
            existing.rootSessionID !== context.rootSessionID ||
            existing.selected?.environmentID !== (session.environmentID ?? undefined) ||
            executions(existing) !== count ||
            (existing.version === 3 ? JSON.stringify(existing.mapping) : undefined) !==
              (mapping ? JSON.stringify(mapping.mapping) : undefined)
          )
            fail("Sealed Environment selection belongs to another source")
          return
        }
        await Records.save(
          S.Source.parse({
            version: mapping ? 3 : 2,
            executions: count,
            kind: "source",
            scopeID: session.scope.id,
            sessionID: session.id,
            rootSessionID: context.rootSessionID,
            handoffID: context.handoffID,
            selected,
            ...(mapping && { mapping: mapping.mapping }),
          }),
        )
      },
      {
        commitGuard() {
          assertOwner()
          mapping?.assert()
        },
      },
    )
    assertOwner()
  }
  async function preparedSource(binding: Epochs.Binding, signal: AbortSignal) {
    const assertOwner = guard(signal)
    const source = await Records.source({
      scopeID: binding.scopeID,
      sessionID: binding.sessionID,
      handoffID: binding.handoffID,
    })
    const session = await Session.get(binding.sessionID)
    await EnvironmentExecution.assertSessionDrained(
      session.scope.id,
      session.id,
      session.environmentID,
      session.workspaceID,
    )
    const current = await Environment.binding(session.scope.id, session.id)
    const count = await historyCount(session.scope.id, session.id, signal)
    const selected = await selection(session.environmentID, session.scope.id)
    assertOwner()
    if (!source || source.rootSessionID !== (binding.rootSessionID ?? binding.sessionID))
      fail("Prepared Environment source evidence is absent")
    if (
      session.scope.id !== binding.scopeID ||
      (source.selected?.environmentID ?? null) !== session.environmentID ||
      (current?.id ?? null) !== session.environmentID ||
      JSON.stringify(source.selected) !== JSON.stringify(selected) ||
      executions(source) !== count
    )
      fail("Prepared Environment evidence disagrees with canonical Session selection")
    return { source, session }
  }
  export async function assertPreparedSource(input: { binding: Epochs.Binding; signal: AbortSignal }) {
    const binding = Epochs.Binding.parse(input.binding)
    const signal = input.signal
    const assertOwner = guard(signal)
    const currentBinding = await Epochs.ownerPreparationBinding(binding)
    if (JSON.stringify(currentBinding) !== JSON.stringify(binding))
      fail("Prepared Environment evidence belongs to another source binding")
    await preparedSource(binding, signal)
    assertOwner()
  }
  async function* exportEntries(context: Owners.SourceContext): AsyncGenerator<SessionTransferStream.Input> {
    context = { ...context, session: structuredClone(context.session) }
    const assertOwner = guard(context.signal)
    const binding = await Epochs.assertFrozen(context.session.id, context.handoffID)
    if (
      binding.scopeID !== context.session.scope.id ||
      (binding.rootSessionID ?? binding.sessionID) !== context.rootSessionID
    )
      fail("Frozen Environment evidence belongs to another source binding")
    const { source, session } = await preparedSource(binding, context.signal)
    const entry = (key: string[], value: unknown): SessionTransferStream.Input => ({
      id: JSON.stringify([ownerID, key]),
      kind: "record",
      metadata: { key },
      content: (async function* () {
        assertOwner()
        yield new TextEncoder().encode(JSON.stringify(value))
      })(),
    })
    yield entry(Records.key(source), source)
    for await (const row of Storage.records({
      prefix: [...Records.prefix, "receipt", source.scopeID, source.sessionID],
      limit: 64,
    })) {
      assertOwner()
      yield entry(row.key, S.Receipt.parse(Records.parse(row.key, row.value)))
    }
    for await (const row of Portable.records({ scopeID: session.scope.id, sessionID: session.id }, context.signal)) {
      assertOwner()
      await Portable.outputCount(row.value, context.signal)
      yield entry(row.key, row.value)
      for (let cursor = 1; cursor <= row.value.execution.outputCursor; cursor++) {
        const key = Portable.outputKey(row.value, cursor)
        const ordinal = cursor
        yield {
          id: JSON.stringify([ownerID, key]),
          kind: "artifact",
          metadata: { key },
          content: (async function* () {
            assertOwner()
            yield await Portable.validateChunk(
              Storage.readBinaryStream(key, { signal: context.signal }),
              ordinal,
              context.signal,
            )
            assertOwner()
          })(),
        }
      }
    }
  }
  async function target(context: Owners.TargetContext) {
    const assertOwner = guard(context.signal)
    const preparation = preparations.get(context)
    const publishing = Storage.inWriteTransaction()
    if (publishing && !preparation) fail("Completed Environment history requires prior native preparation")
    preparation?.assert()
    const hash = createHash("sha256")
    const related = context.staged.relatedRecord
    if (!related || (await context.staged.ownerVersion?.("session-core")) !== 2)
      fail("Environment preparation requires its canonical Core reader")
    const core = await Core.stagedInfo(context.session, (key) => related("session-core", key))
    let source: S.Source | undefined
    let operations = 0
    let expectedOutputs = 0
    for await (const row of context.staged.records()) {
      assertOwner()
      hash.update(JSON.stringify([row.key, row.value]) + "\n")
      if (row.key[0] === "environment_execution") {
        const record = Portable.parse(row.key, row.value, { scopeID: core.info.scope.id, sessionID: core.info.id })
        const [previous] = await Storage.readMany([row.key])
        if (
          previous !== undefined &&
          JSON.stringify(
            Portable.parse(row.key, previous, { scopeID: core.info.scope.id, sessionID: core.info.id }),
          ) !== JSON.stringify(record)
        )
          fail("Portable Environment operation conflicts with retained native history")
        operations = z
          .number()
          .int()
          .nonnegative()
          .safe()
          .parse(operations + 1)
        expectedOutputs = z
          .number()
          .int()
          .nonnegative()
          .safe()
          .parse(expectedOutputs + record.execution.outputCursor)
        continue
      }
      const value = Records.parse(row.key, row.value)
      const original = value.kind === "source" ? value : value.source
      if (original.scopeID !== core.info.scope.id || original.sessionID !== core.info.id)
        fail("Environment evidence belongs to another Session")
      if (value.kind === "source") {
        if (source || value.handoffID !== context.handoffID || value.rootSessionID !== context.rootSessionID)
          fail("Environment source evidence is missing or duplicated")
        source = value
      } else {
        if (original.handoffID === context.handoffID) fail("Environment history claims the current handoff")
        const [existing] = await Storage.readMany([row.key])
        if (existing !== undefined && JSON.stringify(Records.parse(row.key, existing)) !== JSON.stringify(value))
          fail("Environment history conflicts with a retained native receipt")
      }
    }
    let outputs = 0
    for await (const artifact of context.staged.artifacts()) {
      assertOwner()
      const [kind, scopeID, operationID, ordinal] = artifact.key
      if (kind !== "environment_output" || scopeID !== core.info.scope.id || !operationID || !ordinal)
        fail("Portable Environment output belongs to another native owner")
      const key = StoragePath.environmentExecution(scopeID, operationID)
      const raw = await context.staged.record(key)
      if (!raw) fail("Portable Environment output has no operation receipt")
      const record = Portable.parse(raw.key, raw.value, { scopeID, sessionID: core.info.id })
      const cursor = Number(ordinal)
      if (JSON.stringify(artifact.key) !== JSON.stringify(Portable.outputKey(record, cursor)))
        fail("Portable Environment output has another canonical address")
      hash.update(JSON.stringify([artifact.key, artifact.bytes, artifact.sha256]) + "\n")
      if (!publishing) await Portable.validateChunk(artifact.read(), cursor, context.signal)
      outputs = z
        .number()
        .int()
        .nonnegative()
        .safe()
        .parse(outputs + 1)
    }
    if (!source || (source.selected?.environmentID ?? null) !== core.info.environmentID)
      fail("Environment source evidence disagrees with canonical Core selection")
    if (
      operations !== executions(source) ||
      outputs !== expectedOutputs ||
      (context.sourceVersion === 1 && source.version !== 1)
    )
      fail("Portable Environment history omits its declared operation or output closure")
    if (!publishing)
      await Core.validateEnvironmentOrigins(
        context,
        (async function* () {
          for await (const row of context.staged.records()) {
            if (row.key[0] !== "environment_execution") continue
            yield Portable.parse(row.key, row.value, { scopeID: core.info.scope.id, sessionID: core.info.id }).execution
              .origin
          }
        })(),
      )
    const mapped = context.mapping.environmentID
    if (mapped !== null && typeof mapped !== "string") fail("Environment requires an explicit destination mapping")
    if (
      context.mapping.environmentMappingHash !== undefined &&
      (source.version !== 3 || source.mapping.hash !== context.mapping.environmentMappingHash)
    )
      fail("Explicit Environment mapping requires its original versioned source fact")
    const selected = await selection(mapped, core.info.scope.id)
    assertOwner()
    let assertMapping = assertOwner
    if (source.version === 3) {
      const port = mappingSources().get(source.mapping.provider)
      if (!port) fail("Explicit Environment mapping requires its registered native owner")
      const verify = port.target(context, structuredClone(source), selected ? structuredClone(selected) : null)
      if (typeof verify !== "function") fail("Explicit Environment mapping has no original target authority")
      assertMapping = () => {
        assertOwner()
        verify()
      }
      assertMapping()
      hash.update(JSON.stringify({ mapping: source.mapping, target: selected }) + "\n")
    } else {
      if ((source.selected === null) !== (mapped === null))
        fail("Environment mapping cannot erase or introduce a selection")
      if (
        source.selected &&
        selected &&
        (source.selected.provider !== selected.provider ||
          JSON.stringify(source.selected.descriptor) !== JSON.stringify(selected.descriptor))
      )
        fail("Destination Environment has an incompatible registered provider descriptor")
    }
    const digest = hash.digest("hex")
    if (publishing) {
      preparation?.assert()
      if (preparation?.hash !== digest) fail("Prepared Environment history changed before publication")
    } else preparations.set(context, { hash: digest, assert: assertMapping })
    return { source, selected }
  }
  async function publish(context: Owners.TargetContext) {
    const assertOwner = guard(context.signal)
    Epochs.assertActivation({ sessionID: context.session.id, handoffID: context.handoffID })
    const { source, selected } = await target(context)
    const [previous] = await Storage.readMany([["sessions", source.scopeID, source.sessionID, "info"]])
    const prior =
      previous === undefined
        ? undefined
        : Session.PersistedInfo.parse({ ...z.record(z.string(), z.unknown()).parse(previous), workspace: null })
    const current = await Environment.binding(source.scopeID, source.sessionID)
    await EnvironmentExecution.assertSessionDrained(
      source.scopeID,
      source.sessionID,
      selected?.environmentID,
      prior?.workspaceID,
    )
    if ((current?.id ?? null) !== (prior?.environmentID ?? null))
      fail("Existing native Environment binding has another Session owner")
    if ((current?.id ?? null) !== (selected?.environmentID ?? null))
      await Environment.changeBinding({
        scopeID: source.scopeID,
        ownerID: source.sessionID,
        environmentID: selected?.environmentID ?? null,
        expectedEnvironmentID: current?.id ?? null,
      })
    for await (const row of context.staged.records()) {
      if (row.key[0] === "environment_execution") {
        await Portable.install(row.value, { scopeID: source.scopeID, sessionID: source.sessionID })
        continue
      }
      const value = Records.parse(row.key, row.value)
      if (value.kind === "receipt") await Records.save(value)
    }
    for await (const artifact of context.staged.artifacts()) await artifact.publish(artifact.key)
    await Records.save(
      source.version === 3
        ? { version: 3, kind: "receipt", source, target: selected }
        : { version: 2, kind: "receipt", source, target: selected },
    )
    const preparation = preparations.get(context)
    if (!preparation) fail("Completed Environment history lost its original preparation")
    await Storage.transaction(
      async () => {
        assertOwner()
        preparation.assert()
      },
      {
        commitGuard() {
          assertOwner()
          preparation.assert()
        },
      },
    )
  }
  export function register() {
    Owners.register(ownerID, {
      version: 3,
      reads: [1, 2, 3],
      stagedDependencies: ["session-core"],
      publicationBefore: ["session-core"],
      async applies(session, signal) {
        const current = await Session.get(session.id)
        let count = 0
        try {
          count = await historyCount(current.scope.id, current.id, signal, Portable.discoverRecords)
          await selection(current.environmentID, current.scope.id)
        } catch (error) {
          signal.throwIfAborted()
          throw new Owners.Rejected({
            message: "Environment portability is unavailable before native pause",
            requirements: [requirement(error)],
          })
        }
        return (
          !!current.environmentID ||
          count > 0 ||
          [...mappingSources().values()].some((port) => port.applies(current)) ||
          Records.hasReceipts(current.scope.id, current.id)
        )
      },
      inspect,
      freeze,
      export: exportEntries,
      validate: async (context) => {
        await target(context)
      },
      publish,
    })
  }
}

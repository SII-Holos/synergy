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

export namespace SessionTransferEnvironments {
  export const receipt = Records.receipt
  const ownerID = "session-environments"
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
  async function assertNoHistory(scopeID: string, sessionID: string, signal?: AbortSignal) {
    for await (const _ of EnvironmentExecution.sessionEntries({ scopeID, sessionID }, signal))
      fail("Environment execution history requires its lossless portability reader")
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
      await assertNoHistory(session.scope.id, session.id, context.signal)
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
        await assertNoHistory(session.scope.id, session.id, context.signal)
        const current = await Environment.binding(session.scope.id, session.id)
        if ((current?.id ?? null) !== session.environmentID)
          fail("Native Environment binding disagrees with its Session")
        const existing = await Records.source({
          scopeID: session.scope.id,
          sessionID: session.id,
          handoffID: context.handoffID,
        })
        if (existing) {
          if (
            existing.rootSessionID !== context.rootSessionID ||
            existing.selected?.environmentID !== (session.environmentID ?? undefined)
          )
            fail("Sealed Environment selection belongs to another source")
          return
        }
        await Records.save(
          S.Source.parse({
            version: 1,
            kind: "source",
            scopeID: session.scope.id,
            sessionID: session.id,
            rootSessionID: context.rootSessionID,
            handoffID: context.handoffID,
            selected: await selection(session.environmentID, session.scope.id),
          }),
        )
      },
      { commitGuard: assertOwner },
    )
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
    const source = await Records.source({
      scopeID: context.session.scope.id,
      sessionID: context.session.id,
      handoffID: context.handoffID,
    })
    const session = await Session.get(context.session.id)
    const current = await Environment.binding(session.scope.id, session.id)
    await assertNoHistory(session.scope.id, session.id, context.signal)
    assertOwner()
    if (!source || source.rootSessionID !== context.rootSessionID) fail("Frozen Environment source evidence is absent")
    if (
      (source.selected?.environmentID ?? null) !== session.environmentID ||
      (current?.id ?? null) !== session.environmentID
    )
      fail("Frozen Environment evidence disagrees with canonical Session selection")
    const entry = (value: S.Record): SessionTransferStream.Input => ({
      id: JSON.stringify([ownerID, Records.key(value)]),
      kind: "record",
      metadata: { key: Records.key(value) },
      content: (async function* () {
        assertOwner()
        yield new TextEncoder().encode(JSON.stringify(value))
      })(),
    })
    yield entry(source)
    for await (const row of Storage.records({
      prefix: [...Records.prefix, "receipt", source.scopeID, source.sessionID],
      limit: 64,
    })) {
      assertOwner()
      yield entry(S.Receipt.parse(Records.parse(row.key, row.value)))
    }
  }
  async function target(context: Owners.TargetContext) {
    const assertOwner = guard(context.signal)
    const related = context.staged.relatedRecord
    if (!related || (await context.staged.ownerVersion?.("session-core")) !== 2)
      fail("Environment preparation requires its canonical Core reader")
    const core = await Core.stagedInfo(context.session, (key) => related("session-core", key))
    let source: S.Source | undefined
    for await (const row of context.staged.records()) {
      assertOwner()
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
    for await (const _ of context.staged.artifacts())
      fail("Environment descriptor evidence cannot install binary state")
    if (!source || (source.selected?.environmentID ?? null) !== core.info.environmentID)
      fail("Environment source evidence disagrees with canonical Core selection")
    const mapped = context.mapping.environmentID
    if (mapped !== null && typeof mapped !== "string") fail("Environment requires an explicit destination mapping")
    if ((source.selected === null) !== (mapped === null))
      fail("Environment mapping cannot erase or introduce a selection")
    const selected = await selection(mapped, core.info.scope.id)
    assertOwner()
    if (
      source.selected &&
      selected &&
      (source.selected.provider !== selected.provider ||
        JSON.stringify(source.selected.descriptor) !== JSON.stringify(selected.descriptor))
    )
      fail("Destination Environment has an incompatible registered provider descriptor")
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
      const value = Records.parse(row.key, row.value)
      if (value.kind === "receipt") await Records.save(value)
    }
    await Records.save({ version: 1, kind: "receipt", source, target: selected })
    await Storage.transaction(async () => assertOwner(), { commitGuard: assertOwner })
  }
  export function register() {
    Owners.register(ownerID, {
      version: 1,
      reads: [1],
      stagedDependencies: ["session-core"],
      publicationBefore: ["session-core"],
      async applies(session) {
        const current = await Session.get(session.id)
        try {
          await assertNoHistory(current.scope.id, current.id)
          await selection(current.environmentID, current.scope.id)
        } catch (error) {
          throw new Owners.Rejected({
            message: "Environment portability is unavailable before native pause",
            requirements: [requirement(error)],
          })
        }
        return !!current.environmentID || Records.hasReceipts(current.scope.id, current.id)
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

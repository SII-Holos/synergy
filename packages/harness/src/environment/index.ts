import { randomUUID } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { StorageRecovery } from "../storage/recovery"
import { EnvironmentProviders, type EnvironmentRequest } from "./provider"
import { EnvironmentSchema } from "./schema"
import { Log } from "../util/log"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { EnvironmentUseOwnership } from "./use-ownership"

export namespace Environment {
  export const Info = EnvironmentSchema.Info
  export type Info = EnvironmentSchema.Info
  export const Target = EnvironmentSchema.Target
  export type Target = EnvironmentSchema.Target
  export const Use = EnvironmentSchema.Use
  export type Use = EnvironmentSchema.Use
  export const Unavailable = EnvironmentSchema.Unavailable
  export const Stale = EnvironmentSchema.Stale
  export const Busy = EnvironmentSchema.Busy
  export const Event = { Updated: BusEvent.define("environment.updated", Info) }
  async function publishUpdated(info: Info) {
    const scope = await Scope.fromID(info.scopeID)
    if (scope) await ScopeContext.provide({ scope, workspace: null, fn: () => Bus.publish(Event.Updated, info) })
  }
  const pending = RuntimeContext.state(() => new Map<string, Promise<Info>>())
  const providerRequests = RuntimeContext.state(() => new Set<string>())
  const releasePreparations = RuntimeContext.state(() => new Set<string>())
  const epoch = RuntimeContext.state(() => randomUUID())
  const consumers = RuntimeContext.state(() => new Map<string, (info: Info) => Promise<void>>())
  const lostResources = RuntimeContext.state(() => new Map<string, (info: Info) => Promise<boolean>>())

  export function hasPendingRequests() {
    return pending().size > 0 || providerRequests().size > 0
  }

  export function registerResourceOwner(
    name: string,
    release: (info: Info) => Promise<void>,
    lost?: (info: Info) => Promise<boolean>,
  ) {
    RuntimeContext.assertCompositionOpen("Environment resource owners")
    if (consumers().has(name)) throw new Error(`Duplicate Environment resource owner: ${name}`)
    consumers().set(name, release)
    if (lost) lostResources().set(name, lost)
  }

  async function releaseResources(info: Info) {
    for (const release of consumers().values()) await release(info)
  }

  export function registerRecovery(options: { allocation?: "inspect-only" } = {}) {
    if (options.allocation !== undefined && options.allocation !== "inspect-only")
      throw new Error("Unknown Environment allocation recovery mode")
    StorageRecovery.register("environment", options.allocation === "inspect-only" ? recoverInspection : recover)
  }

  export async function get(id: string, scopeID: string): Promise<Info> {
    const [value] = await Storage.readMany<unknown>([StoragePath.environment(id)])
    if (!value) throw new Storage.NotFoundError({ message: "Environment not found in this Scope" })
    const info = Info.parse(value)
    if (info.scopeID !== scopeID) throw new Storage.NotFoundError({ message: "Environment not found in this Scope" })
    return info
  }

  export async function hasState() {
    return Storage.snapshot(async () => {
      for (const prefix of [
        ["environment"],
        ["environment_use"],
        ["environment_execution"],
        ["environment_binding"],
        ["environment_active"],
        ["environment_execution_active"],
      ])
        if ((await Storage.queryKeys({ prefix, limit: 1 })).length) return true
      return false
    })
  }

  export function entries(): AsyncIterable<Info> {
    const current = EnvironmentUseOwnership.captureStorage()
    return (async function* () {
      current()
      for await (const row of Storage.records({ prefix: ["environment"], limit: 128 })) {
        current()
        const info = Info.parse(row.value)
        if (row.key.length !== 2 || row.key[1] !== info.id)
          throw new Error("Environment metadata belongs to another canonical address")
        yield info
      }
      current()
    })()
  }

  export async function list(scopeID: string): Promise<Info[]> {
    const keys = await Storage.list(StoragePath.environmentScope(scopeID))
    return Promise.all(keys.map((key) => get(key[2], scopeID)))
  }

  export async function binding(scopeID: string, ownerID: string): Promise<Info | undefined> {
    const [id] = await Storage.readMany<string>([StoragePath.environmentBinding(scopeID, ownerID)])
    return id ? get(id, scopeID) : undefined
  }

  export async function select(input: {
    scopeID: string
    ownerID: string
    environmentID?: string | null
    workspaceID?: string | null
    selection?: EnvironmentProviders.Default
  }) {
    if (input.environmentID === null) return undefined
    if (input.environmentID) return share(input.environmentID, input)
    const existing = await binding(input.scopeID, input.ownerID)
    if (existing) return existing
    const selection = input.selection ?? (await EnvironmentProviders.resolveDefault())
    if (!selection) return undefined
    const sharedOwner =
      selection.reuse === "scope"
        ? ["default", "scope", input.scopeID, selection.provider, canonical(selection.spec)]
        : selection.reuse === "workspace" && input.workspaceID
          ? ["default", "workspace", input.workspaceID, selection.provider, canonical(selection.spec)]
          : undefined
    const environment = await bind({
      ...input,
      ...selection,
      ownerID: sharedOwner ? JSON.stringify(sharedOwner) : input.ownerID,
    })
    return sharedOwner ? share(environment.id, input) : environment
  }

  export async function selectNative(input: {
    scopeID: string
    ownerID: string
    environmentID?: string | null
    workspaceID?: string | null
    workspaceGeneration?: number
    signal?: AbortSignal
  }) {
    const { signal, ...selection } = { ...input }
    const { EnvironmentExecutionSource } = await import("./execution-source")
    if (await EnvironmentExecutionSource.selected(selection, signal)) return
    if (!selection.environmentID) return
    const environment = await get(selection.environmentID, selection.scopeID)
    signal?.throwIfAborted()
    return environment.provider === "native" ? environment : undefined
  }

  export async function bind(input: {
    scopeID: string
    ownerID: string
    provider: string
    spec: Info["spec"]
    idleTimeoutMs?: number
  }): Promise<Info> {
    const provider = EnvironmentProviders.get(input.provider)
    input = { ...input, spec: provider.validateSpec?.(input.spec) ?? input.spec }
    const now = Date.now()
    const candidate = Info.parse({
      id: `env_${randomUUID().replaceAll("-", "")}`,
      scopeID: input.scopeID,
      provider: input.provider,
      spec: input.spec,
      ownership: provider.ownership ?? "managed",
      state: "idle",
      generation: 0,
      idleTimeoutMs: input.idleTimeoutMs ?? 600_000,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    })
    return Storage.transaction(async () => {
      const existing = await binding(input.scopeID, input.ownerID)
      if (existing) {
        if (existing.provider !== input.provider || canonical(existing.spec) !== canonical(input.spec))
          throw new Busy({
            environmentID: existing.id,
            message: "The owner already has a different Environment binding",
          })
        return existing
      }
      await Storage.write(StoragePath.environment(candidate.id), candidate)
      await Storage.write(StoragePath.environmentScope(candidate.scopeID, candidate.id), candidate.id)
      await Storage.write(StoragePath.environmentBinding(input.scopeID, input.ownerID), candidate.id)
      await publishUpdated(candidate)
      return candidate
    })
  }

  export async function share(id: string, input: { scopeID: string; ownerID: string }) {
    return Storage.transaction(async () => {
      const info = await get(id, input.scopeID)
      const current = await binding(input.scopeID, input.ownerID)
      if (current && current.id !== id)
        throw new Busy({ environmentID: current.id, message: "The owner already has an Environment binding" })
      await Storage.write(StoragePath.environmentBinding(input.scopeID, input.ownerID), id)
      return info
    })
  }

  export async function changeBinding(input: {
    scopeID: string
    ownerID: string
    environmentID: string | null
    expectedEnvironmentID: string | null
  }) {
    return Storage.transaction(async () => {
      const previous = await binding(input.scopeID, input.ownerID)
      if ((previous?.id ?? null) !== input.expectedEnvironmentID)
        throw new Stale({ environmentID: previous?.id ?? "", message: "Environment binding changed" })
      if (previous && (await uses(previous.id)).length)
        throw new Busy({ environmentID: previous.id, message: "Environment still has active or unreconciled uses" })
      const key = StoragePath.environmentBinding(input.scopeID, input.ownerID)
      if (input.environmentID) {
        await get(input.environmentID, input.scopeID)
        await Storage.write(key, input.environmentID)
      } else await Storage.remove(key)
    })
  }

  export async function acquire(
    id: string,
    input: {
      scopeID: string
      useID: string
      capabilities: string[]
      ownership: EnvironmentUseOwnership.Admission
      kind?: "admission"
      expectedTarget?: Target
      signal?: AbortSignal
    },
  ) {
    input = {
      ...input,
      capabilities: [...input.capabilities],
      ...(input.expectedTarget && { expectedTarget: Target.parse(input.expectedTarget) }),
    }
    if (input.expectedTarget && input.expectedTarget.environmentID !== id)
      throw new Stale({ environmentID: id, message: "Environment admission has another expected allocation" })
    if (input.kind !== undefined && input.kind !== "admission")
      throw new Busy({ environmentID: id, message: "Physical Environment Uses require their canonical owner" })
    input.signal?.throwIfAborted()
    EnvironmentUseOwnership.assertCurrent(input.ownership)
    return EnvironmentUseOwnership.request(input.ownership, () => acquireOwned(id, input))
  }

  async function readUse(id: string, useID: string) {
    const [raw] = await Storage.readMany([StoragePath.environmentUse(id, useID)])
    if (raw === undefined) return
    const use = EnvironmentSchema.upgradeUse(raw).use
    if (use.id !== useID || use.target.environmentID !== id)
      throw new Stale({ environmentID: id, message: "Environment Use differs from its canonical address" })
    return use
  }

  async function writeUse(use: EnvironmentSchema.Use) {
    await Storage.write(
      StoragePath.environmentUse(use.target.environmentID, use.id),
      EnvironmentSchema.UseRecord.parse({ schemaVersion: 2, use }),
    )
  }

  async function acquireOwned(
    id: string,
    input: {
      scopeID: string
      useID: string
      capabilities: string[]
      ownership: EnvironmentUseOwnership.Admission
      expectedTarget?: Target
      signal?: AbortSignal
    },
  ) {
    const selector = { scopeID: input.scopeID, environmentID: id, useID: input.useID }
    await RuntimeMaintenance.assertAdmission()
    await EnvironmentUseOwnership.authorize(input.ownership, "admission", selector)
    if (releasePreparations().has(id))
      throw new Busy({ environmentID: id, message: "Environment release owns resource admission" })
    const admission = async () => {
      input.signal?.throwIfAborted()
      await EnvironmentUseOwnership.authorize(input.ownership, "admission", selector)
      input.signal?.throwIfAborted()
    }
    const info = input.expectedTarget
      ? await assertTarget(input.expectedTarget, input.scopeID)
      : await ensure(id, input.scopeID, admission)
    input.signal?.throwIfAborted()
    const target = targetOf(info)
    if (input.capabilities.some((capability) => !info.allocation?.capabilities.includes(capability)))
      throw new Unavailable({
        environmentID: id,
        message: `Environment does not support ${input.capabilities.join(", ")}`,
      })
    const acquired = await Storage.transaction(
      async () => {
        await RuntimeMaintenance.assertAdmission()
        const ownership = await EnvironmentUseOwnership.authorize(input.ownership, "admission", selector, target)
        if (releasePreparations().has(id))
          throw new Busy({ environmentID: id, message: "Environment release owns resource admission" })
        await assertTarget(target, input.scopeID)
        const previous = await readUse(id, input.useID)
        if (previous) {
          if (
            previous.kind !== "operation" ||
            !EnvironmentUseOwnership.transition(previous.ownership, ownership) ||
            JSON.stringify(previous.ownership) !== JSON.stringify(ownership) ||
            !sameTarget(previous.target, target)
          )
            throw new Busy({ environmentID: id, message: "Environment Use is already retained by its original owner" })
          await EnvironmentUseOwnership.inspect(previous, input.scopeID)
          return { use: previous, revision: undefined }
        }
        const use = EnvironmentSchema.Use.parse({
          id: input.useID,
          target,
          createdAt: Date.now(),
          kind: "admission",
          ownership,
          ownerEpoch: epoch(),
        })
        await writeUse(use)
        const [revision] = await Storage.revisions([StoragePath.environmentUse(id, input.useID)])
        if (revision === undefined) throw new Error("Environment admission has no native row revision")
        return { use, revision }
      },
      {
        commitGuard() {
          EnvironmentUseOwnership.assertCurrent(input.ownership)
          input.signal?.throwIfAborted()
        },
      },
    )
    return {
      target,
      use: acquired.use,
      release: async () => {
        EnvironmentUseOwnership.assertCurrent(input.ownership)
        if (acquired.revision === undefined) return
        await Storage.transaction(
          async () => {
            const current = await readUse(id, input.useID)
            if (!current || current.kind === "operation") return
            const [revision] = await Storage.revisions([StoragePath.environmentUse(id, input.useID)])
            if (revision !== acquired.revision || JSON.stringify(current) !== JSON.stringify(acquired.use))
              throw new Stale({ environmentID: id, message: "Environment admission belongs to another native lease" })
            const latest = await get(id, input.scopeID)
            await Storage.remove(StoragePath.environmentUse(id, input.useID))
            await write({ ...latest, lastUsedAt: Date.now() })
          },
          { commitGuard: () => EnvironmentUseOwnership.assertCurrent(input.ownership) },
        )
      },
    }
  }

  export async function uses(id: string): Promise<EnvironmentSchema.Use[]> {
    const result: EnvironmentSchema.Use[] = []
    for await (const use of useEntries(id)) result.push(use)
    return result
  }

  export function useEntries(id?: string): AsyncIterable<EnvironmentSchema.Use> {
    const current = EnvironmentUseOwnership.captureStorage()
    return (async function* () {
      current()
      for await (const row of Storage.records({
        prefix: id === undefined ? ["environment_use"] : StoragePath.environmentUses(id),
        limit: 64,
      })) {
        current()
        const use = EnvironmentSchema.Use.parse(EnvironmentSchema.upgradeUse(row.value).use)
        if (row.key.length !== 3 || row.key[1] !== use.target.environmentID || row.key[2] !== use.id)
          throw new Error("Environment Use differs from its canonical address")
        yield use
        current()
      }
    })()
  }

  export async function inspectUse(use: EnvironmentSchema.Use) {
    const info = Info.parse(await Storage.read(StoragePath.environment(use.target.environmentID)))
    if (info.id !== use.target.environmentID) throw new Error("Environment Use has another canonical Environment")
    const current = await readUse(info.id, use.id)
    if (!current || JSON.stringify(EnvironmentSchema.Use.parse(current)) !== JSON.stringify(use))
      throw new Error("Environment Use changed before its owning inspection")
    return EnvironmentUseOwnership.inspect(current, info.scopeID)
  }

  export async function assertSessionUsesDrained(input: {
    scopeID: string
    sessionID: string
    environmentID?: string | null
    workspaceID?: string | null
  }) {
    input = { ...input }
    const current = EnvironmentUseOwnership.captureStorage()
    for await (const use of useEntries()) {
      current()
      const ownership = use.ownership
      const selected =
        use.target.environmentID === input.environmentID ||
        ("workspaceID" in ownership &&
          ownership.scopeID === input.scopeID &&
          ownership.workspaceID === input.workspaceID)
      if (ownership.kind === "legacy-unknown") {
        if (!selected) continue
        throw new Busy({
          environmentID: use.target.environmentID,
          message: "Selected Environment Use has unknown Session ownership",
        })
      }
      if ("scopeID" in ownership && ownership.scopeID !== input.scopeID && !selected) continue
      if (
        ownership.kind !== "admission" &&
        ownership.kind !== "execution-preparation" &&
        !selected &&
        ownership.kind !== "execution"
      )
        continue
      const inspection = await inspectUse(use)
      current()
      const origin = inspection?.origin
      if (origin?.kind === "host") continue
      if (origin?.kind === "session") {
        if (origin.scopeID !== input.scopeID || origin.sessionID !== input.sessionID) continue
        throw new Busy({
          environmentID: use.target.environmentID,
          message: "Environment Session Use requires its original native owner to release it",
        })
      }
      if (!selected) continue
      throw new Busy({
        environmentID: use.target.environmentID,
        message: "Selected Environment Use has unknown Session ownership",
      })
    }
    current()
  }

  export async function retainUse(
    target: Target,
    scopeID: string,
    useID: string,
    proof: EnvironmentUseOwnership.Token,
  ) {
    target = Target.parse(target)
    await Storage.transaction(
      async () => {
        const ownership = await EnvironmentUseOwnership.authorize(
          proof,
          "retain",
          { scopeID, environmentID: target.environmentID, useID },
          target,
        )
        await assertTarget(target, scopeID)
        const use = await readUse(target.environmentID, useID)
        if (!use || !sameTarget(use.target, target))
          throw new Stale({ environmentID: target.environmentID, message: "Environment admission is unavailable" })
        if (use.kind === "operation" && !EnvironmentUseOwnership.transition(use.ownership, ownership))
          throw new Stale({
            environmentID: target.environmentID,
            message: "Retained Environment Use cannot change its owner",
          })
        if (!EnvironmentUseOwnership.transition(use.ownership, ownership))
          throw new Stale({
            environmentID: target.environmentID,
            message: "Environment Use cannot be retained by another canonical owner",
          })
        await writeUse({ ...use, kind: "operation", ownership, ownerEpoch: undefined })
      },
      { commitGuard: () => EnvironmentUseOwnership.assertCurrent(proof) },
    )
  }

  export async function releaseUse(
    target: Target,
    scopeID: string,
    useID: string,
    proof: EnvironmentUseOwnership.Token,
  ) {
    target = Target.parse(target)
    await Storage.transaction(
      async () => {
        const ownership = await EnvironmentUseOwnership.authorize(
          proof,
          "release",
          { scopeID, environmentID: target.environmentID, useID },
          target,
        )
        const info = await get(target.environmentID, scopeID)
        const key = StoragePath.environmentUse(info.id, useID)
        const use = await readUse(info.id, useID)
        if (!use) return
        if (!sameTarget(use.target, target))
          throw new Stale({ environmentID: info.id, message: "Environment use belongs to another allocation" })
        if (use.kind !== "operation" || JSON.stringify(use.ownership) !== JSON.stringify(ownership))
          throw new Stale({
            environmentID: info.id,
            message: "Environment Use requires its original canonical retirement proof",
          })
        await Storage.remove(key)
        await write({ ...info, lastUsedAt: Date.now() })
      },
      { commitGuard: () => EnvironmentUseOwnership.assertCurrent(proof) },
    )
  }

  export async function assertTarget(target: Target, scopeID: string): Promise<Info> {
    const info = await get(target.environmentID, scopeID)
    if (info.state !== "ready" || info.generation !== target.generation || info.allocation?.id !== target.allocationID)
      throw new Stale({ environmentID: info.id, message: "Environment allocation changed or is unavailable" })
    return info
  }

  export async function deallocate(id: string, input: { scopeID: string; expectedGeneration?: number }) {
    return release(id, input.scopeID, undefined, input.expectedGeneration)
  }

  async function release(id: string, scopeID: string, idleBefore?: number, expectedGeneration?: number) {
    await get(id, scopeID)
    await RuntimeMaintenance.assertAdmission()
    return providerRequest(id, () =>
      withReleasePreparation(id, async () => {
        const selected = await get(id, scopeID)
        if (expectedGeneration !== undefined && selected.generation !== expectedGeneration)
          throw new Stale({ environmentID: id, message: "Environment allocation changed" })
        if (selected.state === "idle" || (idleBefore !== undefined && selected.lastUsedAt > idleBefore)) return selected
        if (selected.state !== "ready")
          throw new Unavailable({ environmentID: id, message: "Reconcile the Environment before releasing it" })
        if ((await uses(id)).length)
          throw new Busy({ environmentID: id, message: "Environment still has active or unreconciled uses" })
        return releaseOwned(selected, async (assertOwner) => {
          return await Storage.transaction(
            async () => {
              assertOwner()
              await RuntimeMaintenance.assertAdmission()
              const info = await get(id, scopeID)
              if (
                info.generation !== selected.generation ||
                info.allocation?.requestID !== selected.allocation?.requestID ||
                info.allocation?.id !== selected.allocation?.id ||
                (expectedGeneration !== undefined && info.generation !== expectedGeneration)
              )
                throw new Stale({ environmentID: id, message: "Environment allocation changed" })
              if (idleBefore !== undefined && info.lastUsedAt > idleBefore) return info
              if (info.state !== "ready")
                throw new Unavailable({ environmentID: id, message: "Reconcile the Environment before releasing it" })
              if ((await uses(id)).length)
                throw new Busy({ environmentID: id, message: "Environment still has active or unreconciled uses" })
              return write({ ...info, state: "releasing" })
            },
            { commitGuard: assertOwner },
          )
        })
      }),
    )
  }

  async function withReleasePreparation<T>(id: string, body: () => Promise<T>) {
    releasePreparations().add(id)
    try {
      return await body()
    } finally {
      releasePreparations().delete(id)
    }
  }

  async function releaseOwned(selected: Info, publish: (assertOwner: () => void) => Promise<Info>) {
    const provider = EnvironmentProviders.get(selected.provider)
    const runtime = RuntimeContext.current()
    const storage = Storage.current()
    let active = true
    const assertOwner = () => {
      if (
        !active ||
        RuntimeContext.current() !== runtime ||
        Storage.current().store !== storage.store ||
        Storage.current().artifactDirectory !== storage.artifactDirectory ||
        Storage.current().artifactObjects !== storage.artifactObjects
      )
        throw new Error("Environment release owner is closed or belongs to another Runtime or storage")
    }
    const performRelease = async () => {
      assertOwner()
      const info = await publish(assertOwner)
      assertOwner()
      if (info.state !== "releasing") return info
      await releaseResources(info)
      assertOwner()
      await provider.deallocate(requestOf(info))
      assertOwner()
      return updateAllocation(info, undefined)
    }
    let owned: Promise<Info> | undefined
    const release = async () => {
      assertOwner()
      return (owned ??= performRelease())
    }
    try {
      if (provider.withDeallocation) await provider.withDeallocation(selected, release)
      else await release()
      if (!owned) throw new Error("Environment provider returned without invoking its release owner")
      return await owned
    } catch (error) {
      if (owned)
        await owned.catch((failure) => {
          if (failure !== error)
            throw new AggregateError([error, failure], "Environment release and provider wrapper failed")
        })
      throw error
    } finally {
      active = false
    }
  }

  export async function reclaimIdle(scopeID: string, now = Date.now()) {
    const reclaimed: string[] = []
    for (const info of await list(scopeID)) {
      if (info.ownership !== "managed" || info.state !== "ready" || now - info.lastUsedAt < info.idleTimeoutMs) continue
      try {
        const released = await release(info.id, scopeID, now - info.idleTimeoutMs)
        if (released.state === "idle") reclaimed.push(info.id)
      } catch (error) {
        if (!(error instanceof Busy))
          Log.create({ service: "environment" }).warn("Idle Environment remains unreclaimed", {
            environmentID: info.id,
            error,
          })
      }
    }
    return reclaimed
  }

  export async function reconcile(id: string, scopeID: string): Promise<Info> {
    return reconcileOwned(id, scopeID, false)
  }

  export async function reconcileInspection(id: string, scopeID: string): Promise<Info> {
    return reconcileOwned(id, scopeID, true)
  }

  async function reconcileOwned(id: string, scopeID: string, inspection: boolean): Promise<Info> {
    const info = await get(id, scopeID)
    // Recovery cannot retire a provider request still owned by this Runtime.
    if (providerRequests().has(id)) return info
    return providerRequest(id, async () => {
      if (!info.allocation) return info
      const provider = EnvironmentProviders.get(info.provider)
      if (info.state === "releasing")
        return withReleasePreparation(id, () =>
          releaseOwned(info, async (assertOwner) => {
            assertOwner()
            await RuntimeMaintenance.assertMutation()
            const latest = await get(id, scopeID)
            if (
              latest.state !== "releasing" ||
              latest.allocation?.requestID !== info.allocation?.requestID ||
              !sameTarget(targetOf(latest), targetOf(info))
            )
              throw new Stale({ environmentID: id, message: "Environment release allocation changed" })
            return latest
          }),
        )
      const status = await provider.inspect(requestOf(info))
      if (status.state === "pending") {
        if (inspection && info.state === "allocating") return info
        if (info.state !== "allocating" || !provider.resume || (await uses(id)).length)
          return updateAllocation(info, "unknown")
        return updateAllocation(info, await provider.resume(requestOf(info)))
      }
      if (status.state === "unknown") return updateAllocation(info, "unknown")
      if (status.state === "absent") {
        let retained = false
        for (const lost of lostResources().values()) retained = (await lost(info)) || retained
        if (retained) return updateAllocation(info, "unknown")
        if ((await uses(id)).length) return updateAllocation(info, "unknown")
        return updateAllocation(info, undefined)
      }
      return updateAllocation(info, status.allocation)
    })
  }

  function recoverInspection(progress?: () => void) {
    return recover(progress, true)
  }

  async function recover(progress?: () => void, inspection = false) {
    for (const key of await Storage.list(StoragePath.environmentActive())) {
      const [scopeID] = await Storage.readMany<string>([key])
      progress?.()
      if (!scopeID) continue
      for (const use of await uses(key[1])) {
        if (
          !inspection &&
          use.kind === "admission" &&
          use.ownership.kind !== "legacy-unknown" &&
          use.ownerEpoch !== epoch()
        )
          await releaseRecoveredAdmission(use, scopeID)
        progress?.()
      }
      try {
        await reconcileOwned(key[1], scopeID, inspection)
      } catch {
        const info = await get(key[1], scopeID)
        if (info.state !== "releasing") await updateAllocation(info, "unknown")
      }
      progress?.()
    }
  }

  export async function retireRecoveredAdmission(value: EnvironmentSchema.Use, scopeID: string) {
    const previous = EnvironmentSchema.Use.parse(structuredClone(value))
    const runtime = RuntimeContext.current(),
      primary = runtime.storage,
      current = Storage.current()
    if (
      !primary ||
      current.store !== primary.store ||
      current.artifactDirectory !== primary.artifactDirectory ||
      current.artifactObjects !== primary.artifactObjects ||
      current.store.options.readonly ||
      previous.kind !== "admission" ||
      previous.ownership.kind === "legacy-unknown" ||
      previous.ownerEpoch === epoch()
    )
      throw new Unavailable({
        environmentID: previous.target.environmentID,
        message: "Recovered admission requires its actual old native Use and writable primary",
      })
    return releaseRecoveredAdmission(previous, scopeID)
  }

  async function releaseRecoveredAdmission(previous: EnvironmentSchema.Use, scopeID: string) {
    const runtime = RuntimeContext.current()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const namespace = JSON.stringify(store.options)
    const config = artifactObjects && {
      blobs: artifactObjects.blobs,
      writerID: artifactObjects.writerID,
      now: artifactObjects.now,
    }
    const guard = () => {
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        JSON.stringify(store.options) !== namespace ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects ||
        artifactObjects?.blobs !== config?.blobs ||
        artifactObjects?.writerID !== config?.writerID ||
        artifactObjects?.now !== config?.now
      )
        throw new Error("Recovered Environment admission belongs to another native Store")
    }
    await Storage.transaction(
      async () => {
        guard()
        const info = await get(previous.target.environmentID, scopeID)
        const current = await readUse(info.id, previous.id)
        if (!current) return
        if (
          current.kind !== "admission" ||
          current.ownerEpoch === epoch() ||
          JSON.stringify(current) !== JSON.stringify(previous)
        )
          throw new Busy({
            environmentID: info.id,
            message: "Recovered admission is still held by another native owner",
          })
        await Storage.remove(StoragePath.environmentUse(info.id, previous.id))
        await write({ ...info, lastUsedAt: Date.now() })
      },
      { commitGuard: guard },
    )
  }

  async function ensure(id: string, scopeID: string, admission: () => Promise<void>): Promise<Info> {
    const current = pending().get(id)
    if (current) {
      await get(id, scopeID)
      const info = await current
      await admission()
      return info
    }
    const promise = allocate(id, scopeID, admission)
    pending().set(id, promise)
    try {
      return await promise
    } finally {
      pending().delete(id)
    }
  }

  async function allocate(id: string, scopeID: string, admission: () => Promise<void>): Promise<Info> {
    await admission()
    let info = await get(id, scopeID)
    if (info.state === "ready") return info
    if (info.state !== "idle") info = await reconcile(id, scopeID)
    if (info.state === "ready") return info
    if (info.state !== "idle")
      throw new Unavailable({
        environmentID: id,
        message: "Environment allocation is uncertain; reconcile it before executing",
      })
    await RuntimeMaintenance.assertAdmission()
    return providerRequest(id, async () => {
      const requestID = `alloc_${randomUUID().replaceAll("-", "")}`
      info = await Storage.transaction(async () => {
        await admission()
        await RuntimeMaintenance.assertAdmission()
        const latest = await get(id, scopeID)
        if (latest.state !== "idle")
          throw new Busy({ environmentID: id, message: "Environment is already being allocated" })
        await Storage.write(StoragePath.environmentActive(id), scopeID)
        return write({
          ...latest,
          state: "allocating",
          generation: latest.generation + 1,
          allocation: { requestID, capabilities: [] },
        })
      })
      await admission()
      const allocation = EnvironmentSchema.Allocation.parse(
        await EnvironmentProviders.get(info.provider).allocate(requestOf(info)),
      )
      await admission()
      return updateAllocation(info, allocation)
    })
  }

  async function providerRequest<T>(id: string, body: () => Promise<T>): Promise<T> {
    const requests = providerRequests()
    if (requests.has(id)) throw new Busy({ environmentID: id, message: "Environment has an owned provider request" })
    requests.add(id)
    try {
      return await body()
    } finally {
      requests.delete(id)
    }
  }

  async function updateAllocation(previous: Info, allocation: EnvironmentSchema.Allocation | "unknown" | undefined) {
    return Storage.transaction(async () => {
      const current = await get(previous.id, previous.scopeID)
      if (
        current.generation !== previous.generation ||
        current.allocation?.requestID !== previous.allocation?.requestID ||
        current.state !== previous.state
      )
        throw new Stale({ environmentID: previous.id, message: "Environment changed during the provider request" })
      if (!allocation) await Storage.remove(StoragePath.environmentActive(current.id))
      return write({
        ...current,
        state: allocation === "unknown" ? "unavailable" : allocation ? "ready" : "idle",
        lastUsedAt:
          allocation && allocation !== "unknown" && current.state === "allocating" ? Date.now() : current.lastUsedAt,
        allocation:
          allocation === "unknown"
            ? current.allocation
            : allocation
              ? { requestID: requestOf(current).requestID, ...allocation }
              : undefined,
      })
    })
  }

  async function write(info: Info) {
    const next = Info.parse({ ...info, updatedAt: Math.max(Date.now(), info.updatedAt + 1) })
    await Storage.write(StoragePath.environment(info.id), next)
    await publishUpdated(next)
    return next
  }

  export function requestOf(info: Info): EnvironmentRequest {
    if (!info.allocation) throw new Unavailable({ environmentID: info.id, message: "Environment has no allocation" })
    return {
      environmentID: info.id,
      generation: info.generation,
      requestID: info.allocation.requestID,
      spec: info.spec,
    }
  }

  export function targetOf(info: Info): Target {
    return Target.parse({ environmentID: info.id, allocationID: info.allocation?.id, generation: info.generation })
  }

  export function sameTarget(a: Target, b: Target) {
    return EnvironmentSchema.sameTarget(a, b)
  }

  function canonical(value: Info["spec"] | Info["spec"][string]): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
}

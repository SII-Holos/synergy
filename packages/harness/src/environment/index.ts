import { randomUUID } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { StorageRecovery } from "../storage/recovery"
import { EnvironmentProviders, type EnvironmentRequest } from "./provider"
import { EnvironmentSchema } from "./schema"
import { Log } from "../util/log"

export namespace Environment {
  export const Info = EnvironmentSchema.Info
  export type Info = EnvironmentSchema.Info
  export const Target = EnvironmentSchema.Target
  export type Target = EnvironmentSchema.Target
  export const Unavailable = EnvironmentSchema.Unavailable
  export const Stale = EnvironmentSchema.Stale
  export const Busy = EnvironmentSchema.Busy
  const pending = RuntimeContext.state(() => new Map<string, Promise<Info>>())
  const epoch = RuntimeContext.state(() => randomUUID())
  const consumers = RuntimeContext.state(() => new Map<string, (info: Info) => Promise<void>>())
  const lostResources = RuntimeContext.state(() => new Map<string, (info: Info) => Promise<boolean>>())

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

  export function registerRecovery() {
    StorageRecovery.register("environment", recover)
  }

  export async function get(id: string, scopeID: string): Promise<Info> {
    const [value] = await Storage.readMany<unknown>([StoragePath.environment(id)])
    if (!value) throw new Storage.NotFoundError({ message: "Environment not found in this Scope" })
    const info = Info.parse(value)
    if (info.scopeID !== scopeID) throw new Storage.NotFoundError({ message: "Environment not found in this Scope" })
    return info
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
  }) {
    if (input.environmentID === null) return undefined
    if (input.environmentID) return share(input.environmentID, input)
    const existing = await binding(input.scopeID, input.ownerID)
    if (existing) return existing
    const selection = EnvironmentProviders.defaultSelection()
    if (!selection) return undefined
    const sharedOwner =
      selection.reuse === "scope"
        ? ["default", "scope", input.scopeID]
        : selection.reuse === "workspace" && input.workspaceID
          ? ["default", "workspace", input.workspaceID]
          : undefined
    const environment = await bind({
      ...input,
      ...selection,
      ownerID: sharedOwner ? JSON.stringify(sharedOwner) : input.ownerID,
    })
    return sharedOwner ? share(environment.id, input) : environment
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

  export async function acquire(
    id: string,
    input: {
      scopeID: string
      useID: string
      capabilities: string[]
      kind?: EnvironmentSchema.Use["kind"]
      signal?: AbortSignal
    },
  ) {
    input.signal?.throwIfAborted()
    const info = await ensure(id, input.scopeID)
    input.signal?.throwIfAborted()
    const target = targetOf(info)
    if (input.capabilities.some((capability) => !info.allocation?.capabilities.includes(capability)))
      throw new Unavailable({
        environmentID: id,
        message: `Environment does not support ${input.capabilities.join(", ")}`,
      })
    await Storage.transaction(async () => {
      await assertTarget(target, input.scopeID)
      await Storage.write(
        StoragePath.environmentUse(id, input.useID),
        EnvironmentSchema.Use.parse({
          id: input.useID,
          target,
          createdAt: Date.now(),
          kind: input.kind,
          ownerEpoch: input.kind === "admission" ? epoch() : undefined,
        }),
      )
    })
    return {
      target,
      release: () => releaseUse(target, input.scopeID, input.useID),
    }
  }

  export async function uses(id: string): Promise<EnvironmentSchema.Use[]> {
    const keys = await Storage.list(StoragePath.environmentUses(id))
    return (await Storage.readMany<unknown>(keys)).flatMap((value) =>
      value === undefined ? [] : [EnvironmentSchema.Use.parse(value)],
    )
  }

  export async function releaseUse(target: Target, scopeID: string, useID: string) {
    await Storage.transaction(async () => {
      const info = await get(target.environmentID, scopeID)
      const key = StoragePath.environmentUse(info.id, useID)
      const [use] = await Storage.readMany<EnvironmentSchema.Use>([key])
      if (!use) return
      if (!sameTarget(use.target, target))
        throw new Stale({ environmentID: info.id, message: "Environment use belongs to another allocation" })
      await Storage.remove(key)
      await Storage.write(StoragePath.environment(info.id), { ...info, lastUsedAt: Date.now() })
    })
  }

  export async function assertTarget(target: Target, scopeID: string): Promise<Info> {
    const info = await get(target.environmentID, scopeID)
    if (info.state !== "ready" || info.generation !== target.generation || info.allocation?.id !== target.allocationID)
      throw new Stale({ environmentID: info.id, message: "Environment allocation changed or is unavailable" })
    return info
  }

  export async function deallocate(id: string, input: { scopeID: string }) {
    return release(id, input.scopeID)
  }

  async function release(id: string, scopeID: string, idleBefore?: number) {
    const info = await Storage.transaction(async () => {
      const info = await get(id, scopeID)
      if (info.state === "idle") return info
      if (idleBefore !== undefined && info.lastUsedAt > idleBefore) return info
      if (info.state !== "ready")
        throw new Unavailable({ environmentID: id, message: "Reconcile the Environment before releasing it" })
      if ((await uses(id)).length)
        throw new Busy({ environmentID: id, message: "Environment still has active or unreconciled uses" })
      return write({ ...info, state: "releasing" })
    })
    if (info.state !== "releasing") return info
    await releaseResources(info)
    await EnvironmentProviders.get(info.provider).deallocate(requestOf(info))
    return updateAllocation(info, undefined)
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
    const info = await get(id, scopeID)
    if (!info.allocation) return info
    const status = await EnvironmentProviders.get(info.provider).inspect(requestOf(info))
    if (status.state === "pending") {
      const provider = EnvironmentProviders.get(info.provider)
      if (info.state === "releasing") {
        await releaseResources(info)
        await provider.deallocate(requestOf(info))
        return updateAllocation(info, undefined)
      }
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
    if (info.state === "releasing") {
      await releaseResources(info)
      await EnvironmentProviders.get(info.provider).deallocate(requestOf(info))
      return updateAllocation(info, undefined)
    }
    return updateAllocation(info, status.allocation)
  }

  async function recover() {
    for (const key of await Storage.list(StoragePath.environmentActive())) {
      const [scopeID] = await Storage.readMany<string>([key])
      if (!scopeID) continue
      for (const use of await uses(key[1])) {
        if (use.kind === "admission" && use.ownerEpoch !== epoch()) await releaseUse(use.target, scopeID, use.id)
      }
      try {
        await reconcile(key[1], scopeID)
      } catch {
        const info = await get(key[1], scopeID)
        await updateAllocation(info, "unknown")
      }
    }
  }

  async function ensure(id: string, scopeID: string): Promise<Info> {
    const current = pending().get(id)
    if (current) {
      await get(id, scopeID)
      return current
    }
    const promise = allocate(id, scopeID)
    pending().set(id, promise)
    try {
      return await promise
    } finally {
      pending().delete(id)
    }
  }

  async function allocate(id: string, scopeID: string): Promise<Info> {
    let info = await get(id, scopeID)
    if (info.state === "ready") return info
    if (info.state !== "idle") info = await reconcile(id, scopeID)
    if (info.state === "ready") return info
    if (info.state !== "idle")
      throw new Unavailable({
        environmentID: id,
        message: "Environment allocation is uncertain; reconcile it before executing",
      })
    const requestID = `alloc_${randomUUID().replaceAll("-", "")}`
    info = await Storage.transaction(async () => {
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
    const allocation = EnvironmentSchema.Allocation.parse(
      await EnvironmentProviders.get(info.provider).allocate(requestOf(info)),
    )
    return updateAllocation(info, allocation)
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
    const next = Info.parse({ ...info, updatedAt: Date.now() })
    await Storage.write(StoragePath.environment(info.id), next)
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

import { StoragePath } from "@/storage/path"
import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"
import { SynergyLinkTarget } from "./types"

export namespace SynergyLinkTargetStore {
  const collectionLock = "synergy-link:targets"

  export async function list(): Promise<SynergyLinkTarget.Info[]> {
    const root = StoragePath.synergyLinkTargetsRoot()
    const ids = await Storage.scan(root)
    const records = await Storage.readMany<unknown>(ids.map((id) => StoragePath.synergyLinkTarget(id)))
    return records
      .map((record, index) => parsePersistedTarget(record, ids[index] ?? "unknown"))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  export async function listForAgent(agent: string): Promise<SynergyLinkTarget.Info[]> {
    return (await list()).filter((target) => target.enabled && canAgentAccess(target, agent))
  }

  export function canAgentAccess(target: SynergyLinkTarget.Info, agent: string): boolean {
    return target.allowedAgents.length === 0 || target.allowedAgents.includes(agent)
  }

  export function assertAgentAccess(target: SynergyLinkTarget.Info, agent: string): void {
    if (!canAgentAccess(target, agent)) {
      throw new Error(`Synergy Link target ${target.id} is not available to agent ${agent}`)
    }
  }

  export async function get(id: string): Promise<SynergyLinkTarget.Info | undefined> {
    const parsedID = SynergyLinkTarget.ID.safeParse(id)
    if (!parsedID.success) return undefined
    const record = await Storage.read<unknown>(StoragePath.synergyLinkTarget(parsedID.data)).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    return record === undefined ? undefined : parsePersistedTarget(record, parsedID.data)
  }

  export async function findByLocator(
    linkID: string,
    targetAgentID?: string,
  ): Promise<SynergyLinkTarget.Info | undefined> {
    return (await list()).find(
      (target) => target.linkID === linkID && (!targetAgentID || target.targetAgentID === targetAgentID),
    )
  }

  export async function assertLocatorAvailable(id: string, linkID: string): Promise<void> {
    const duplicate = (await list()).find((target) => target.id !== id && target.linkID === linkID)
    if (duplicate) {
      throw new Error(`Synergy Link locator already in use: link "${linkID}" is used by target ${duplicate.id}.`)
    }
  }

  export async function require(id: string): Promise<SynergyLinkTarget.Info> {
    const target = await get(id)
    if (!target) throw new Storage.NotFoundError({ message: `Synergy Link target not found: ${id}` })
    return target
  }

  export async function create(input: SynergyLinkTarget.CreateInput): Promise<SynergyLinkTarget.Info> {
    const parsed = SynergyLinkTarget.CreateInput.parse(input)
    using _ = await Lock.write(collectionLock)
    const duplicate = (await list()).find((target) => target.linkID === parsed.linkID)
    if (duplicate) throw new Error(`Synergy Link target already exists: ${duplicate.id}`)

    const now = Date.now()
    const target = SynergyLinkTarget.Info.parse({
      id: `target_${crypto.randomUUID()}`,
      ...parsed,
      authorization: "unverified",
      createdAt: now,
      updatedAt: now,
    })
    await Storage.write(StoragePath.synergyLinkTarget(target.id), target)
    return target
  }

  export async function update(
    id: string,
    input: SynergyLinkTarget.PatchInput,
    verified?: { host?: SynergyLinkTarget.HostObservation },
  ): Promise<SynergyLinkTarget.Info> {
    const patch = SynergyLinkTarget.PatchInput.parse(input)
    using _ = await Lock.write(collectionLock)
    const current = await require(id)
    const now = Date.now()

    let observations: Partial<SynergyLinkTarget.Info> = {}
    if (patch.kind === "relink") {
      await assertLocatorAvailable(id, patch.linkID)
      if (verified?.host && verified.host.linkID !== patch.linkID) {
        throw new Error(`Synergy Link host identity mismatch for target ${id}`)
      }
      const locatorChanged = patch.linkID !== current.linkID || patch.targetAgentID !== current.targetAgentID
      if (verified) {
        observations = {
          authorization: "approved",
          host: verified.host,
          lastProbe: { status: "reachable", checkedAt: now },
        }
      } else if (locatorChanged) {
        observations = { authorization: "unverified", host: undefined, lastProbe: undefined }
      }
    }

    const target = SynergyLinkTarget.Info.parse({ ...current, ...patch, ...observations, updatedAt: now })
    await Storage.write(StoragePath.synergyLinkTarget(target.id), target)
    return target
  }

  export async function recordProbe(
    id: string,
    input: {
      status: SynergyLinkTarget.Probe["status"]
      host?: SynergyLinkTarget.HostObservation
    },
  ): Promise<SynergyLinkTarget.Info> {
    using _ = await Lock.write(collectionLock)
    const current = await require(id)
    if (input.host && input.host.linkID !== current.linkID) {
      throw new Error(`Synergy Link host identity mismatch for target ${id}`)
    }
    const now = Date.now()
    const target = SynergyLinkTarget.Info.parse({
      ...current,
      authorization:
        input.status === "reachable" ? "approved" : input.status === "refused" ? "revoked" : current.authorization,
      host: input.host ?? current.host,
      lastProbe: { status: input.status, checkedAt: now },
      updatedAt: now,
    })
    await Storage.write(StoragePath.synergyLinkTarget(target.id), target)
    return target
  }

  export async function remove(id: string): Promise<void> {
    using _ = await Lock.write(collectionLock)
    await Storage.remove(StoragePath.synergyLinkTarget(id))
  }
}

function parsePersistedTarget(record: unknown, id: string): SynergyLinkTarget.Info {
  const parsed = SynergyLinkTarget.Info.safeParse(record)
  if (parsed.success) return parsed.data
  throw new Error(`Invalid persisted Synergy Link target ${id}: ${parsed.error.message}`)
}

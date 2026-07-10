import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { StoragePath } from "../storage/path"
import { Storage } from "../storage/storage"
import { WorkflowError } from "./error"
import { WorkflowTypes } from "./types"

/**
 * CharterStore — charters are immutable per version. Creating a new version of
 * an existing charter appends a new document; a run always pins a specific
 * (id, version) so an in-flight run is never mutated by a later charter edit.
 */
export namespace CharterStore {
  export type CreateInput = {
    id?: string
    name: string
    description?: string
    entityType: string
    entityInitialState: string
    states: string[]
    terminalStates?: string[]
    seats: WorkflowTypes.SeatDef[]
    transitions: WorkflowTypes.TransitionDef[]
    gates?: WorkflowTypes.GateDef[]
    budget?: { maxModelCalls: number }
  }

  export async function latestVersion(scopeID: string, charterID: string): Promise<number> {
    const sid = Identifier.asScopeID(scopeID)
    const versions = await Storage.scan(StoragePath.charterVersionsRoot(sid, charterID))
    return versions.reduce((max, v) => Math.max(max, Number(v) || 0), 0)
  }

  export async function get(scopeID: string, charterID: string, version?: number): Promise<WorkflowTypes.Charter> {
    const sid = Identifier.asScopeID(scopeID)
    const resolved = version ?? (await latestVersion(scopeID, charterID))
    if (resolved < 1) throw new WorkflowError.CharterNotFound({ charterID, version })
    const charter = await Storage.read<WorkflowTypes.Charter>(StoragePath.charter(sid, charterID, resolved)).catch(
      () => undefined,
    )
    if (!charter) throw new WorkflowError.CharterNotFound({ charterID, version: resolved })
    return charter
  }

  export async function getOrUndefined(
    scopeID: string,
    charterID: string,
    version?: number,
  ): Promise<WorkflowTypes.Charter | undefined> {
    return get(scopeID, charterID, version).catch(() => undefined)
  }

  export async function list(scopeID: string): Promise<WorkflowTypes.Charter[]> {
    const sid = Identifier.asScopeID(scopeID)
    const charterIDs = await Storage.scan(StoragePath.charterRoot(sid))
    const latest: WorkflowTypes.Charter[] = []
    for (const charterID of charterIDs) {
      const charter = await getOrUndefined(scopeID, charterID)
      if (charter) latest.push(charter)
    }
    return latest.sort((a, b) => b.time.created - a.time.created)
  }

  /**
   * Persist a new charter version. When `input.id` is given and already exists,
   * this bumps to the next version; otherwise it mints a fresh charter at v1.
   * The caller is responsible for validation (CharterValidate) before create.
   */
  export async function create(input: CreateInput): Promise<WorkflowTypes.Charter> {
    const scopeID = ScopeContext.current.scope.id
    const sid = Identifier.asScopeID(scopeID)
    const charterID = input.id ?? Identifier.ascending("charter")
    const nextVersion = (await latestVersion(scopeID, charterID)) + 1

    const charter = WorkflowTypes.Charter.parse({
      id: charterID,
      version: nextVersion,
      name: input.name,
      description: input.description,
      entityType: input.entityType,
      entityInitialState: input.entityInitialState,
      states: input.states,
      terminalStates: input.terminalStates ?? [],
      seats: input.seats,
      transitions: input.transitions,
      gates: input.gates ?? [],
      budget: input.budget ?? { maxModelCalls: 0 },
      time: { created: Date.now() },
    })

    await Storage.write(StoragePath.charter(sid, charterID, nextVersion), charter)
    return charter
  }

  /** Persist a charter object verbatim (used for seeding built-in templates). */
  export async function put(scopeID: string, charter: WorkflowTypes.Charter): Promise<WorkflowTypes.Charter> {
    const sid = Identifier.asScopeID(scopeID)
    const parsed = WorkflowTypes.Charter.parse(charter)
    await Storage.write(StoragePath.charter(sid, parsed.id, parsed.version), parsed)
    return parsed
  }
}

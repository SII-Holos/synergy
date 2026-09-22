import { Storage } from "../storage/storage"
import { upgradeSessionRecords } from "../migration"
import type { Info } from "./types"
import { WorkspaceCatalog } from "../workspace/catalog"
import type { StoreTransaction } from "../storage/transactional-store"

export namespace SessionRecords {
  export async function readMany(keys: string[][]): Promise<Array<Info | undefined>> {
    await upgradeSessionRecords(
      keys.map((key) => {
        if (key.length !== 4 || key[0] !== "sessions" || key[3] !== "info")
          throw new Error("Expected a Session info key")
        return { scopeID: key[1], sessionID: key[2] }
      }),
    )
    const records = await Storage.readMany<Info>(keys)
    return Promise.all(records.map((record) => record && hydrate(record)))
  }

  export function serialize(info: Info) {
    const { workspace, working: _working, workspaceError: _error, ...stored } = info
    if (workspace && !workspace.id) throw new Error("Session workspace must be registered before persistence")
    return { ...stored, workspaceID: workspace?.id ?? info.workspaceID ?? null }
  }

  export async function hydrate(info: Info, transaction?: Pick<StoreTransaction, "readMany">): Promise<Info> {
    if (info.workspaceID === undefined) return info
    if (info.workspaceID === null) return { ...info, workspace: null }
    const workspace = await WorkspaceCatalog.get(info.workspaceID, info.scope.id, transaction).catch((error) => {
      if (!(error instanceof Storage.NotFoundError)) throw error
      return undefined
    })
    return {
      ...info,
      workspace: workspace ? WorkspaceCatalog.projection(workspace) : null,
      workspaceError: workspace?.binding.path ? undefined : "Workspace metadata is unavailable",
    }
  }

  export async function update(key: string[], editor: (info: Info) => void): Promise<Info> {
    await read(key)
    return Storage.transaction(async () => {
      const info = await hydrate(await Storage.read<Info>(key))
      editor(info)
      await Storage.write(key, serialize(info))
      return info
    })
  }

  export async function read(key: string[]): Promise<Info> {
    const [record] = await readMany([key])
    if (!record) throw new Storage.NotFoundError({ message: `Session ${key[2]} not found` })
    return record
  }
}

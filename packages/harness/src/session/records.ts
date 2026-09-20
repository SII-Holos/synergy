import { Storage } from "../storage/storage"
import { upgradeSessionRecords } from "../migration"
import type { Info } from "./types"

export namespace SessionRecords {
  export async function readMany(keys: string[][]): Promise<Array<Info | undefined>> {
    await upgradeSessionRecords(
      keys.map((key) => {
        if (key.length !== 4 || key[0] !== "sessions" || key[3] !== "info")
          throw new Error("Expected a Session info key")
        return { scopeID: key[1], sessionID: key[2] }
      }),
    )
    return Storage.readMany<Info>(keys)
  }

  export async function read(key: string[]): Promise<Info> {
    const [record] = await readMany([key])
    if (!record) throw new Storage.NotFoundError({ message: `Session ${key[2]} not found` })
    return record
  }
}

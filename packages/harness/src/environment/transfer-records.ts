import { Storage } from "../storage/storage"
import { EnvironmentPortableSchema as S } from "./portable-schema"

export namespace EnvironmentTransferRecords {
  export const prefix = ["environment_transfer"]
  export const key = (record: S.Record) => {
    const source = record.kind === "source" ? record : record.source
    return [...prefix, record.kind, source.scopeID, source.sessionID, source.handoffID]
  }
  export function parse(address: readonly string[], value: unknown) {
    const record = S.Record.parse(value)
    if (JSON.stringify(address) !== JSON.stringify(key(record)))
      throw new Error("Environment transfer record belongs to another canonical address")
    return record
  }
  export async function source(input: { scopeID: string; sessionID: string; handoffID: string }) {
    const address = [...prefix, "source", input.scopeID, input.sessionID, input.handoffID]
    const [value] = await Storage.readMany([address])
    if (value === undefined) return
    return S.Source.parse(parse(address, value))
  }
  export async function hasReceipts(scopeID: string, sessionID: string) {
    return (await Storage.queryKeys({ prefix: [...prefix, "receipt", scopeID, sessionID], limit: 1 })).length > 0
  }
  export async function receipt(input: { scopeID: string; sessionID: string; handoffID: string }) {
    const address = [...prefix, "receipt", input.scopeID, input.sessionID, input.handoffID]
    const [value] = await Storage.readMany([address])
    if (value === undefined) return
    return S.Receipt.parse(parse(address, value))
  }
  export async function save(record: S.Record) {
    if (!Storage.inWriteTransaction()) throw new Error("Environment transfer records require their native transaction")
    const value = S.Record.parse(record)
    const address = key(value)
    const [existing] = await Storage.readMany([address])
    if (existing !== undefined) {
      if (JSON.stringify(parse(address, existing)) !== JSON.stringify(value))
        throw new Error("An immutable Environment transfer record cannot change")
      return
    }
    await Storage.write(address, value)
  }
}

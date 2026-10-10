import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { Asset } from "../asset/asset"
import { Storage } from "../storage/storage"
import { Truncate } from "../tool/truncation"
import { SessionTransferSchema as S } from "./transfer-schema"
import { SessionTransferArchive as Archive } from "./transfer-archive"

export namespace SessionTransferDependencies {
  type Record = z.infer<typeof S.Record>
  const OutputID = z.string().regex(/^tool_[a-zA-Z0-9_-]{1,128}$/)
  const Alias = z.object({ alias: z.string().min(1).max(4096), id: OutputID }).strict()
  const aliasKey = (reference: string) => ["tool_output_aliases", Archive.hash(reference)]
  const outputKey = (id: string) => ["tool_outputs", OutputID.parse(id), "info"]
  const canonicalID = (reference: string) =>
    reference.startsWith("tool-output://") ? OutputID.parse(reference.slice("tool-output://".length)) : undefined

  function references(records: Record[]) {
    const assets = new Set<string>()
    const outputs = new Set<string>()
    const walk = (value: unknown) => {
      if (typeof value === "string") {
        const asset = AssetReference.parse(value)
        if (asset) assets.add(asset.id)
        if (value.startsWith("tool-output://")) outputs.add(value)
      } else if (value && typeof value === "object") {
        const part = value as { type?: unknown; state?: { metadata?: { outputPath?: unknown } } }
        const reference = part.type === "tool" ? part.state?.metadata?.outputPath : undefined
        if (typeof reference === "string") outputs.add(reference)
        for (const child of Object.values(value)) walk(child)
      }
    }
    for (const record of records) walk(record.value)
    return { assets, outputs }
  }

  export function keys(owners: Record[], entries: Record[]) {
    const refs = references(owners)
    const result = [...refs.assets].map((id) => ["asset_manifest", id])
    for (const reference of refs.outputs) {
      const id = canonicalID(reference)
      if (id) {
        result.push(outputKey(id))
        continue
      }
      const key = aliasKey(reference)
      const value = entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(key))?.value
      const alias = Alias.parse(value)
      if (alias.alias !== reference) throw new S.Rejected({ message: "Session transfer tool output alias mismatch" })
      result.push(key, outputKey(alias.id))
    }
    return [...new Map(result.map((key) => [JSON.stringify(key), key])).values()]
  }

  export async function capture(owners: Record[]) {
    const refs = references(owners)
    const records = new Map<string, Record>()
    const artifacts = new Map<string, { key: string[]; bytes: Uint8Array }>()
    const add = (key: string[], value: unknown, dataKey: string[], bytes: Uint8Array) => {
      const previous = records.get(JSON.stringify(key))
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(value))
        throw new S.Rejected({ message: "Session transfer dependency identity collision" })
      records.set(JSON.stringify(key), { key, value })
      artifacts.set(JSON.stringify(dataKey), { key: dataKey, bytes })
    }
    for (const id of refs.assets) {
      const file = await Asset.read(id)
      if (!file || file.size > Archive.limit) throw new S.Rejected({ message: "Missing or oversized Session asset" })
      const bytes = await file.bytes()
      const sha256 = Archive.hash(bytes)
      if (!sha256.startsWith(id.split(".")[0]!)) throw new S.Rejected({ message: "Session asset checksum mismatch" })
      add(["asset_manifest", id], { bytes: bytes.length, sha256 }, ["assets", id], bytes)
    }
    for (const reference of refs.outputs) {
      let id = canonicalID(reference)
      let bytes: Uint8Array
      if (!id) {
        const [previous] = await Storage.readMany([aliasKey(reference)])
        if (previous) {
          const alias = Alias.parse(previous)
          if (alias.alias !== reference) throw new S.Rejected({ message: "Session tool output alias mismatch" })
          id = alias.id
        } else {
          id = OutputID.parse(path.basename(reference))
          const directory = await fs.realpath(Truncate.directory())
          const filename = await fs.realpath(reference)
          const stat = await fs.lstat(reference)
          if (path.dirname(filename) !== directory || !stat.isFile() || stat.size > 32 * 1024 * 1024)
            throw new S.Rejected({ message: "Session transfer requires a retained tool output file" })
          bytes = await fs.readFile(filename)
          if (bytes.length !== stat.size)
            throw new S.Rejected({ message: "Session tool output changed during transfer" })
          new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          add(
            outputKey(id),
            { version: 1, bytes: bytes.length, sha256: Archive.hash(bytes) },
            ["tool_outputs", id, "content"],
            bytes,
          )
        }
        records.set(JSON.stringify(aliasKey(reference)), { key: aliasKey(reference), value: { alias: reference, id } })
      }
      if (records.has(JSON.stringify(outputKey(id)))) continue
      const value = await Storage.read(outputKey(id))
      const info = z
        .object({
          version: z.literal(1),
          bytes: z
            .number()
            .int()
            .nonnegative()
            .max(32 * 1024 * 1024),
          sha256: S.Hash,
        })
        .strict()
        .parse(value)
      bytes = await Storage.readBinary(["tool_outputs", id, "content"], { maxBytes: info.bytes })
      if (bytes.length !== info.bytes || Archive.hash(bytes) !== info.sha256)
        throw new S.Rejected({ message: "Session tool output checksum mismatch" })
      add(outputKey(id), info, ["tool_outputs", id, "content"], bytes)
    }
    return { records: [...records.values()], artifacts: [...artifacts.values()] }
  }

  export async function assets(archive: Awaited<ReturnType<typeof Archive.open>>, publish = false) {
    for (const artifact of archive.manifest.artifacts.filter((artifact) => artifact.key[0] === "assets")) {
      const id = artifact.key[1]!
      const bytes = await archive.bytes(artifact.file)
      const previous = await Asset.read(id)
      if (previous && Archive.hash(await previous.bytes()) !== Archive.hash(bytes))
        throw new S.Rejected({ message: "Session transfer asset collides with destination data" })
      if (publish) await Asset.publish(id, bytes, { durable: true })
    }
  }
}

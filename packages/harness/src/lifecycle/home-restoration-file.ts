import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { z } from "zod"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { HomeOwnershipFile } from "./home-ownership-file"

export const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const RestorationRequest = z.strictObject({
  restoreID: ID,
  owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  sourceHash: Hash,
  payload: JsonValue,
})
export const Physical = z.strictObject({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) })
export const Artifacts = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("present"), directory: z.string(), identity: Physical }),
  z.strictObject({
    kind: z.literal("future"),
    directory: z.string(),
    parent: z.string(),
    parentIdentity: Physical,
  }),
])
export type Artifacts = z.infer<typeof Artifacts>
export const StagingDisk = z.strictObject({
  schemaVersion: z.literal(1),
  restoreID: ID,
  owner: RestorationRequest.shape.owner,
  sourceHash: Hash,
  requestHash: Hash,
  installationID: z.uuid(),
  incarnation: z.uuid(),
  phase: z.literal("staging"),
  target: z.strictObject({
    home: z.string(),
    root: z.string(),
    homeIdentity: Physical,
    rootIdentity: Physical,
    storageHash: Hash,
    artifacts: Artifacts,
  }),
})
export const Completion = z.strictObject({
  schemaVersion: z.literal(2),
  phase: z.literal("completed"),
  intentHash: Hash,
  publicationHash: Hash,
})
export const CompletedDisk = StagingDisk.extend({
  schemaVersion: z.literal(2),
  phase: z.literal("completed"),
  publicationHash: Hash,
})
export const Disk = z.discriminatedUnion("schemaVersion", [StagingDisk, CompletedDisk])
export const StagingInfo = StagingDisk.omit({ target: true })
export const CompletedInfo = CompletedDisk.omit({ target: true })
export type Disk = z.infer<typeof Disk>
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const filename = (root: string) => path.join(root, "home-restoration.json")
export class RestorationError extends Error {
  override readonly name = "HomeRestorationBlocked"
}
export function staging(record: Disk) {
  const { publicationHash: _, ...base } = { publicationHash: undefined, ...record }
  return StagingDisk.parse({ ...base, schemaVersion: 1, phase: "staging" })
}
export function completion(record: Disk, publicationHash: string) {
  return (
    JSON.stringify(
      Completion.parse({
        schemaVersion: 2,
        phase: "completed",
        intentHash: digest(staging(record)),
        publicationHash,
      }),
    ) + "\n"
  )
}
export function decode(bytes: Uint8Array, publicationHash?: string, baseOnly = false): Disk {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  try {
    return StagingDisk.parse(JSON.parse(text))
  } catch {}
  const boundary = text.indexOf("\n")
  const base = StagingDisk.parse(JSON.parse(text.slice(0, boundary)))
  if (boundary < 0 || text.slice(0, boundary + 1) !== JSON.stringify(base) + "\n")
    throw new RestorationError("Native restoration intent has no canonical original frame")
  const tail = text.slice(boundary + 1)
  try {
    const committed = Completion.parse(JSON.parse(tail))
    if (committed.intentHash !== digest(base) || tail !== completion(base, committed.publicationHash))
      throw new RestorationError("Native restoration completion belongs to another original intent")
    return CompletedDisk.parse({
      ...base,
      schemaVersion: 2,
      phase: "completed",
      publicationHash: committed.publicationHash,
    })
  } catch (error) {
    if (baseOnly || (publicationHash && completion(base, publicationHash).startsWith(tail))) return base
    throw error
  }
}

export async function physical(directory: string) {
  const info = await fs.lstat(directory, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new RestorationError("Installation requires an independent canonical native target")
  return Physical.parse({ device: info.dev.toString(), inode: info.ino.toString() })
}
export async function read(root: string, publicationHash?: string, baseOnly = false): Promise<Disk | undefined> {
  let file: Awaited<ReturnType<typeof fs.open>>
  try {
    const before = await fs.lstat(filename(root))
    if (!before.isFile() || before.isSymbolicLink() || before.size > 8192)
      throw new RestorationError("Native restoration intent is invalid or unsupported")
    file = await fs.open(filename(root), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const initial = await file.stat()
      if (initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== before.size)
        throw new RestorationError("Native restoration intent changed while opening")
      const bytes = new Uint8Array(initial.size + 1)
      let used = 0
      for (;;) {
        const next = await file.read(bytes, used, bytes.byteLength - used, used)
        if (!next.bytesRead) break
        used += next.bytesRead
        if (used > initial.size) throw new RestorationError("Native restoration intent changed while reading")
      }
      const final = await file.stat()
      const retained = await fs.lstat(filename(root))
      if (
        used !== initial.size ||
        final.mtimeMs !== initial.mtimeMs ||
        final.ctimeMs !== initial.ctimeMs ||
        retained.dev !== initial.dev ||
        retained.ino !== initial.ino
      )
        throw new RestorationError("Native restoration intent changed while reading")
      try {
        return decode(bytes.subarray(0, used), publicationHash, baseOnly)
      } catch {
        throw new RestorationError("Native restoration intent is invalid or unsupported")
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export async function inspectCompleted(input: {
  home: string
  root: string
  env?: Record<string, string | undefined>
}) {
  const home = path.resolve(input.home)
  const root = path.resolve(input.root)
  if (root !== path.join(home, ".synergy"))
    throw new RestorationError("Native Home completion requires its canonical root")
  const record = await read(root)
  if (!record || record.phase !== "completed") throw new RestorationError("Native Home restoration is incomplete")
  const files = HomeOwnershipFile.open({ root, env: input.env ?? process.env })
  const ownership = HomeOwnershipFile.RestorationInfo.parse(await files.read())
  if (
    ownership.owner !== record.owner ||
    ownership.installationID !== record.installationID ||
    ownership.incarnation !== record.incarnation ||
    (await fs.realpath(home)) !== record.target.home ||
    (await fs.realpath(root)) !== record.target.root ||
    digest(await physical(home)) !== digest(record.target.homeIdentity) ||
    digest(await physical(root)) !== digest(record.target.rootIdentity)
  )
    throw new RestorationError("Restored Home ownership requires its actual native installation intent")
  await HomeOwnershipFile.open({ root, env: input.env ?? process.env, selected: ownership }).assert({ required: true })
  const retained = await read(root)
  if (digest(retained) !== digest(record))
    throw new RestorationError("Native Home completion changed during inspection")
  const { target: _, ...info } = record
  return CompletedInfo.parse(info)
}

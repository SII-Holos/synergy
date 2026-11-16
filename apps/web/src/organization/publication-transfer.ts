import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import type {
  OrganizationClient,
  OrgPublicationFile,
  OrgPublicationUpload,
} from "@ericsanchezok/synergy-sdk/organization"

const chunkBytes = Publication.chunkBytes
const check = (signal: AbortSignal) => signal.throwIfAborted()

export async function publicationFileHash(blob: Blob, signal: AbortSignal) {
  const hash = sha256.create()
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    check(signal)
    hash.update(new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer()))
  }
  check(signal)
  return bytesToHex(hash.digest())
}

export async function uploadPublication(
  api: OrganizationClient,
  input: {
    requestID: string
    purpose: "knowledge" | "artifact"
    scope: Publication.Scope
    sourceSessionID?: string
    files: { path: string; blob: Blob }[]
    signal: AbortSignal
    progress?: (input: { path: string; bytes: number; total: number }) => void
  },
) {
  const options = { throwOnError: true, signal: input.signal } as const
  const paths = input.files.map((file) => Publication.Path.parse(file.path))
  if (new Set(paths).size !== paths.length || !paths.length) throw new Error("Publication files must have unique paths")
  const totalBytes = input.files.reduce((sum, file) => sum + file.blob.size, 0)
  if (!Number.isSafeInteger(totalBytes)) throw new Error("Publication size is not valid")
  check(input.signal)
  const prepared = await api.orgPublications.createUpload(
    {
      requestID: input.requestID,
      purpose: input.purpose,
      scope: input.scope,
      sourceSessionID: input.sourceSessionID,
    },
    options,
  )
  const uploadID = prepared.data.uploadID
  if (prepared.data.state === "sealed") return prepared.data
  const manifest: OrgPublicationFile[] = []
  let sent = 0
  for (const [index, file] of input.files.entries()) {
    const digest = await publicationFileHash(file.blob, input.signal)
    const declared = await api.orgPublications.putFile(
      {
        uploadID,
        path: paths[index]!,
        bytes: file.blob.size,
        sha256: digest,
        mediaType: file.blob.type || "application/octet-stream",
      },
      options,
    )
    manifest.push(declared.data)
    for (let offset = 0; offset < file.blob.size; offset += chunkBytes) {
      check(input.signal)
      const body = file.blob.slice(offset, offset + chunkBytes)
      await api.orgPublications.putChunk({ uploadID, fileID: declared.data.fileID, offset, body }, options)
      sent += body.size
      input.progress?.({ path: file.path, bytes: sent, total: totalBytes })
    }
  }
  const hash = sha256.create()
  for (const file of manifest.sort((a, b) => a.fileID.localeCompare(b.fileID)))
    hash.update(new TextEncoder().encode(Publication.manifestLine(file)))
  const sealed = await api.orgPublications.seal(
    { uploadID, fileCount: manifest.length, totalBytes, manifestHash: bytesToHex(hash.digest()) },
    options,
  )
  return sealed.data satisfies OrgPublicationUpload
}

export async function streamPublicationDownload(input: {
  file: Pick<OrgPublicationFile, "bytes" | "sha256">
  signal: AbortSignal
  read: (start: number, end: number) => Promise<{ bytes: Uint8Array; status: number; contentRange: string | null }>
  append: (bytes: Uint8Array) => Promise<void>
}) {
  const hash = sha256.create()
  for (let offset = 0; offset < input.file.bytes; offset += chunkBytes) {
    check(input.signal)
    const end = Math.min(input.file.bytes, offset + chunkBytes) - 1
    const value = await input.read(offset, end)
    check(input.signal)
    if (
      value.status !== 206 ||
      value.contentRange !== `bytes ${offset}-${end}/${input.file.bytes}` ||
      value.bytes.byteLength !== end - offset + 1
    )
      throw new Error("Publication download integrity check failed")
    hash.update(value.bytes)
    await input.append(value.bytes)
  }
  check(input.signal)
  if (bytesToHex(hash.digest()) !== input.file.sha256) throw new Error("Publication download integrity check failed")
}

import { S3Client } from "bun"
import OSS from "ali-oss"
import { Readable } from "node:stream"
import type { BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"

export interface ObjectStorageOptions {
  bucket: string
  region: string
  endpoint?: string
  prefix?: string
  credentials(): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>
}

function prepare(options: ObjectStorageOptions) {
  if (options.endpoint) {
    const url = new URL(options.endpoint)
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Object storage endpoint must not contain credentials or query parameters")
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
      throw new Error("Object storage requires HTTPS")
  }
  const prefix = options.prefix?.replace(/\/$/, "") ?? "synergy/workspaces"
  WorkspaceTree.Path.parse(prefix)
  return (hash: string) => `${prefix}/sha256/${WorkspaceTree.Hash.parse(hash).slice(0, 2)}/${hash}`
}

async function bounded(source: AsyncIterable<Uint8Array>, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > WorkspaceTree.manifestBytes)
    throw new Error("Invalid Workspace object read limit")
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of source) {
    size += chunk.byteLength
    if (size > maximumBytes) throw new Error("Workspace object exceeds the read limit")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

async function* readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

// Provenance: https://bun.sh/docs/runtime/s3 — the bundled SigV4 client owns signing and credential encoding.
export function s3BlobStore(options: ObjectStorageOptions): BlobStore {
  const key = prepare(options)
  const client = async () =>
    new S3Client({
      ...(await options.credentials()),
      bucket: options.bucket,
      region: options.region,
      endpoint: options.endpoint,
    })
  return {
    async put(hash, bytes) {
      WorkspaceTree.verify(hash, bytes, WorkspaceTree.manifestBytes)
      await (await client()).write(key(hash), bytes, { type: "application/octet-stream" })
    },
    async get(hash, maximumBytes) {
      const stream = (await client()).file(key(hash)).stream()
      return WorkspaceTree.verify(hash, await bounded(readStream(stream), maximumBytes), maximumBytes)
    },
  }
}

// Provenance: https://www.alibabacloud.com/help/en/oss/developer-reference/guidelines-for-upgrading-v1-signatures-to-v4-signatures
// OSS uses its own V4 signing scope; its official SDK implements that protocol rather than an S3 compatibility assumption.
export function ossBlobStore(options: ObjectStorageOptions & { cname?: boolean }): BlobStore {
  const key = prepare(options)
  const client = async () => {
    const credentials = await options.credentials()
    return new OSS({
      bucket: options.bucket,
      region: options.region,
      endpoint: options.endpoint,
      cname: options.cname,
      authorizationV4: true,
      secure: options.endpoint ? new URL(options.endpoint).protocol === "https:" : true,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.secretAccessKey,
      stsToken: credentials.sessionToken,
      timeout: 60_000,
    })
  }
  return {
    async put(hash, bytes) {
      WorkspaceTree.verify(hash, bytes, WorkspaceTree.manifestBytes)
      await (await client()).put(key(hash), Buffer.from(bytes), { mime: "application/octet-stream" })
    },
    async get(hash, maximumBytes) {
      const response = await (await client()).getStream(key(hash))
      const stream: unknown = response.stream
      if (!(stream instanceof Readable)) throw new Error("OSS did not return an object stream")
      try {
        return WorkspaceTree.verify(hash, await bounded(stream, maximumBytes), maximumBytes)
      } finally {
        stream.destroy()
      }
    },
  }
}

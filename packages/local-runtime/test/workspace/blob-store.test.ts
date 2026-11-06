import { expect, test } from "bun:test"
import { s3BlobStore, ossBlobStore } from "../../src/workspace/blob-store"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"

for (const protocol of ["s3", "oss"] as const)
  test(`${protocol} blob transport signs requests and verifies content-addressed bytes`, async () => {
    const data = new Map<string, Uint8Array>()
    const authorizations: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorizations.push(request.headers.get("authorization") ?? "")
        const key = new URL(request.url).pathname
        if (request.method === "DELETE") {
          data.delete(key)
          return new Response(null, { status: 204, headers: { "x-oss-request-id": "fixture" } })
        }
        if (request.method === "PUT") {
          data.set(key, new Uint8Array(await request.arrayBuffer()))
          return new Response(null, { headers: { etag: '"fixture"', "x-oss-request-id": "fixture" } })
        }
        const bytes = data.get(key)
        return new Response(bytes ? new Uint8Array(bytes) : null, {
          status: bytes ? 200 : 404,
          headers: { "content-length": String(bytes?.length ?? 0), "x-oss-request-id": "fixture" },
        })
      },
    })
    const credentials = async () => ({ accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" })
    const options = {
      endpoint: server.url.toString(),
      bucket: "fixture-bucket",
      region: protocol === "oss" ? "oss-cn-hangzhou" : "us-east-1",
      prefix: "workspace",
      credentials,
    }
    const store = protocol === "s3" ? s3BlobStore(options) : ossBlobStore({ ...options, cname: true })
    try {
      const bytes = new Uint8Array([0, 1, 255, 128, 4])
      const hash = WorkspaceTree.hash(bytes)
      await store.put(hash, bytes)
      expect(await store.get(hash, bytes.length)).toEqual(bytes)
      expect(
        authorizations.every((authorization) =>
          authorization.startsWith(protocol === "oss" ? "OSS4-HMAC-SHA256 " : "AWS4-HMAC-SHA256 "),
        ),
      ).toBe(true)
      await expect(store.get(hash, 2)).rejects.toThrow()
      await expect(store.put(hash, new Uint8Array([3]))).rejects.toThrow("integrity")
      for (const key of data.keys()) data.set(key, new Uint8Array([3]))
      await expect(store.get(hash, bytes.length)).rejects.toThrow("integrity")
      await expect(store.delete("../outside")).rejects.toThrow()
      await store.delete(hash)
      await store.delete(hash)
      expect(data.size).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

import { expect, test } from "bun:test"
import { buildClientParams } from "../src/gen/core/params.gen"
import { buildClientParams as organizationParams } from "../src/organization-gen/core/params.gen"
import { createOrganizationClient } from "../src/organization"

test("generated parameter mapping preserves native request bodies and drops only empty plain slots", () => {
  const bytes = new Uint8Array([0, 255, 128, 1])
  const form = new FormData()
  form.append("data", new Blob([bytes]))
  const bodies = [new Blob([bytes]), new File([bytes], "binary.bin"), bytes.buffer, bytes, form, new URLSearchParams({ key: "value" })]
  for (const build of [buildClientParams, organizationParams]) {
    for (const body of bodies) {
      expect(build([body], [{ in: "body" }])).toEqual({ body })
      expect(build([{ body, offset: 0 }], [{ args: [{ in: "body" }, { in: "query", key: "offset" }] }])).toEqual({ body, query: { offset: 0 } })
    }
    expect(build([undefined], [])).toEqual({})
  }
})

test("the generated publication SDK sends non-UTF8 Blob bytes over real HTTP", async () => {
  const received: Uint8Array[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/org/v1/publications/uploads/upload/files/file/chunks")
    expect(request.headers.get("content-type")).toBe("application/octet-stream")
    expect(request.headers.get("authorization")).toBe("Bearer fixture-binary")
    received.push(new Uint8Array(await request.arrayBuffer()))
    return Response.json({ ok: true })
  } })
  try {
    const client = createOrganizationClient({ baseUrl: server.url.toString(), headers: { authorization: "Bearer fixture-binary" } })
    const bytes = new Uint8Array(150_002).fill(255)
    await client.orgPublications.putChunk({ uploadID: "upload", fileID: "file", offset: 0, body: new Blob([bytes]) }, { throwOnError: true })
    expect(received).toEqual([bytes])
  } finally { await server.stop(true) }
})

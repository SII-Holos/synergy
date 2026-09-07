import { describe, expect, spyOn, test } from "bun:test"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutRecordingError } from "../../src/session/rollout/error"
import { Storage } from "../../src/storage/storage"

function owner(): RolloutArtifact.Owner {
  return { kind: "operation", scopeID: "test", operationID: crypto.randomUUID() }
}

async function collect(input: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = []
  for await (const chunk of input) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe("rollout artifacts", () => {
  test("reads the captured prefix even when a live writer later completes", async () => {
    const target = owner()
    const writer = await RolloutArtifact.open(target, "text/plain")
    await writer.append(new TextEncoder().encode("before"))
    const boundary = await writer.checkpoint()
    await writer.append(new TextEncoder().encode("after"))
    await writer.finish()
    expect(boundary.bytes).toBe(6)
    expect(await collect(RolloutArtifact.read(target, boundary))).toEqual(Buffer.from("before"))
    expect(await collect(RolloutArtifact.read(target, writer.id))).toEqual(Buffer.from("beforeafter"))
  })

  test("commits an empty stream without inventing a chunk", async () => {
    const target = owner()
    async function* source() {}
    const ref = await RolloutArtifact.write(target, source(), "text/plain")
    expect(ref.bytes).toBe(0)
    expect(ref.chunks).toBe(0)
    expect(ref.status).toBe("complete")
    expect(await collect(RolloutArtifact.read(target, ref.id))).toEqual(Buffer.alloc(0))
  })

  test("shares identical content chunks within their owner", async () => {
    const target = owner()
    async function* source() {
      yield new Uint8Array([1, 2, 3])
    }
    const first = await RolloutArtifact.write(target, source(), "application/octet-stream")
    const second = await RolloutArtifact.write(target, source(), "application/octet-stream")
    expect(first.id).not.toBe(second.id)
    expect(first.sha256).toBe(second.sha256)
    expect(await Storage.scan([...RolloutArtifact.root(target), "blobs"], { strict: true })).toHaveLength(1)
  })

  test("preserves content across producer chunk boundaries", async () => {
    const target = owner()
    const data = new Uint8Array(RolloutArtifact.CHUNK_BYTES * 2 + 13)
    for (let index = 0; index < data.length; index++) data[index] = index % 251
    async function* source() {
      yield data.subarray(0, 17)
      yield data.subarray(17)
    }
    const ref = await RolloutArtifact.write(target, source(), "application/octet-stream")
    expect(ref.bytes).toBe(data.length)
    expect(ref.chunks).toBe(3)
    expect(ref.status).toBe("complete")
    expect(ref.sha256).toBe(new Bun.CryptoHasher("sha256").update(data).digest("hex"))
    expect(await collect(RolloutArtifact.read(target, ref.id))).toEqual(Buffer.from(data))
  })

  test("retains the committed prefix when the source fails", async () => {
    const target = owner()
    async function* source() {
      yield new Uint8Array(RolloutArtifact.CHUNK_BYTES).fill(42)
      throw new Error("source interrupted")
    }
    await expect(RolloutArtifact.write(target, source(), "application/octet-stream")).rejects.toThrow(
      "source interrupted",
    )
    const [ref] = await RolloutArtifact.list(target)
    expect(ref.status).toBe("partial")
    expect(ref.bytes).toBe(RolloutArtifact.CHUNK_BYTES)
    expect(await collect(RolloutArtifact.read(target, ref.id))).toEqual(Buffer.alloc(RolloutArtifact.CHUNK_BYTES, 42))
  })

  test("stops consuming a producer when persistence fails", async () => {
    const target = owner()
    let produced = 0
    async function* source() {
      while (++produced <= 3) yield new Uint8Array(RolloutArtifact.CHUNK_BYTES)
    }
    using write = spyOn(Storage, "writeBinary").mockRejectedValue(
      Object.assign(new Error("disk full"), { code: "ENOSPC" }),
    )
    await expect(RolloutArtifact.write(target, source(), "application/octet-stream")).rejects.toBeInstanceOf(
      RolloutRecordingError,
    )
    expect(produced).toBe(1)
    const [ref] = await RolloutArtifact.list(target)
    expect(ref.bytes).toBe(0)
    expect(ref.status).toBe("partial")
  })

  test("preserves a short observation when its source fails", async () => {
    const target = owner()
    async function* source() {
      yield new Uint8Array([5, 6, 7])
      throw new Error("cancelled")
    }
    await expect(RolloutArtifact.write(target, source(), "application/octet-stream")).rejects.toThrow("cancelled")
    const [ref] = await RolloutArtifact.list(target)
    expect(ref.status).toBe("partial")
    expect(await collect(RolloutArtifact.read(target, ref.id))).toEqual(Buffer.from([5, 6, 7]))
  })

  test("does not publish completion when the final commit fails", async () => {
    const target = owner()
    const original = Storage.write.bind(Storage)
    using write = spyOn(Storage, "write").mockImplementation(async (key, data, options) => {
      if (data && typeof data === "object" && "status" in data && data.status === "complete") {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
      }
      return original(key, data, options)
    })
    async function* source() {
      yield new Uint8Array([1])
    }
    await expect(RolloutArtifact.write(target, source(), "application/octet-stream")).rejects.toBeInstanceOf(
      RolloutRecordingError,
    )
    const [ref] = await RolloutArtifact.list(target)
    expect(ref.status).toBe("partial")
    expect(ref.bytes).toBe(1)
  })

  test("rejects corrupt stored content", async () => {
    const target = owner()
    async function* source() {
      yield new Uint8Array([1, 2, 3])
    }
    const ref = await RolloutArtifact.write(target, source(), "application/octet-stream")
    using read = spyOn(Storage, "readBinary").mockResolvedValue(new Uint8Array([1, 2, 4]))
    await expect(collect(RolloutArtifact.read(target, ref.id))).rejects.toThrow("integrity")
  })

  test("rejects an owner outside its storage namespace", async () => {
    const target = { ...owner(), scopeID: "../private" }
    async function* source() {
      yield new Uint8Array()
    }
    await expect(RolloutArtifact.write(target, source(), "text/plain")).rejects.toThrow()
  })
})

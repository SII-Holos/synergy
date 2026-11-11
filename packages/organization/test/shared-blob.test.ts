import { expect, test, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSessionDirectory as Directory } from "../src/session-directory"
import { OrganizationSharing as Sharing } from "../src/sharing"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { directoryFixture } from "./support/session-directory"

async function shared(f: Awaited<ReturnType<typeof directoryFixture>>) {
  await f.run(() =>
    Directory.reservePrivate(f.credentials.alice, {
      sessionID: "blob-pages",
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  await f.run(() => Sharing.share(f.credentials.alice, "blob-pages", { expectedShareGeneration: 0 }))
}

test("reading a shared Session cannot upload or replace its projection bytes", async () => {
  await using f = await directoryFixture()
  await shared(f)
  const bytes = new TextEncoder().encode("Creator-owned bytes")
  const hash = createHash("sha256").update(bytes).digest("hex")
  for (const actor of ["bob", "reader"])
    await expect(
      f.run(() =>
        Sharing.uploadBlob(f.credentials[actor], "blob-pages", {
          shareGeneration: 1,
          hash,
          offset: 0,
          totalBytes: bytes.length,
          bytes,
        }),
      ),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
  expect(
    (
      await f.run(() =>
        Sharing.uploadBlob(f.credentials.alice, "blob-pages", {
          shareGeneration: 1,
          hash,
          offset: 0,
          totalBytes: bytes.length,
          bytes,
        }),
      )
    ).complete,
  ).toBe(true)
})

test("a shared blob is incomplete until verification commits, even after its last chunk arrives", async () => {
  await using f = await directoryFixture()
  await shared(f)
  const bytes = new TextEncoder().encode("Verify before publication")
  const hash = createHash("sha256").update(bytes).digest("hex")
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const verifying = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = Storage.readBinary
  let intercepted = false
  const read = spyOn(Storage, "readBinary").mockImplementation(async (key, options) => {
    if (!intercepted && JSON.stringify(key) === JSON.stringify(Keys.sharedBlobChunk("blob-pages", 1, hash, 0))) {
      intercepted = true
      entered()
      await barrier
    }
    return original(key, options)
  })
  const uploading = f.run(() =>
    Sharing.uploadBlob(f.credentials.alice, "blob-pages", {
      shareGeneration: 1,
      hash,
      offset: 0,
      totalBytes: bytes.length,
      bytes,
    }),
  )
  try {
    await verifying
    const visible = await f.run(() =>
      Sharing.getBlobStatus(f.credentials.bob, "blob-pages", { shareGeneration: 1, hash }),
    )
    expect(visible.complete).toBe(false)
  } finally {
    release()
    await uploading
    read.mockRestore()
  }
  expect(
    (await f.run(() => Sharing.getBlobStatus(f.credentials.bob, "blob-pages", { shareGeneration: 1, hash }))).complete,
  ).toBe(true)
})

test("shared blob receipts survive out-of-order delivery, exact retry and restart before complete verification", async () => {
  await using f = await directoryFixture()
  await shared(f)
  const first = new Uint8Array(4 * 1024 * 1024).fill(17)
  const last = new Uint8Array([0, 255, 128])
  const hash = createHash("sha256").update(first).update(last).digest("hex")
  const input = { shareGeneration: 1, hash, totalBytes: first.length + last.length }
  const tail = await f.run(() =>
    Sharing.uploadBlob(f.credentials.alice, "blob-pages", { ...input, offset: first.length, bytes: last }),
  )
  expect(tail).toMatchObject({ complete: false, receivedBytes: last.length, nextOffset: 0 })
  expect(
    await f.run(() =>
      Sharing.uploadBlob(f.credentials.alice, "blob-pages", { ...input, offset: first.length, bytes: last }),
    ),
  ).toEqual(tail)
  await expect(
    f.run(() =>
      Sharing.uploadBlob(f.credentials.alice, "blob-pages", {
        ...input,
        offset: first.length,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ),
  ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
  await expect(
    f.run(() =>
      Sharing.uploadBlob(f.credentials.alice, "blob-pages", { ...input, offset: 0, bytes: new Uint8Array([1]) }),
    ),
  ).rejects.toMatchObject({ data: { code: "INVALID_REQUEST" } })
  await f.restart()
  expect(
    (await f.run(() => Sharing.uploadBlob(f.credentials.alice, "blob-pages", { ...input, offset: 0, bytes: first })))
      .complete,
  ).toBe(true)
  const response = await f.run(() =>
    Sharing.downloadBlob(f.credentials.bob, "blob-pages", {
      shareGeneration: 1,
      hash,
      range: `bytes=${first.length - 1}-${first.length + 2}`,
    }),
  )
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([17, ...last]))
})

test("legacy shared blob manifests page beyond the old total chunk cap without enlarging their header", async () => {
  const { sharedBlobMigration } = await import("../src/shared-blob")
  await using f = await directoryFixture()
  await shared(f)
  const chunkBytes = 4 * 1024 * 1024
  const oldCount = 16_384
  const hash = "a".repeat(64)
  const key = Keys.sharedBlob("blob-pages", 1, hash)
  await f.run(() =>
    Storage.write(key, {
      schemaVersion: 1,
      sessionID: "blob-pages",
      shareGeneration: 1,
      hash,
      bytes: (oldCount + 2) * chunkBytes,
      chunkBytes,
      chunks: Array.from({ length: oldCount }, (_, index) => ({ offset: index * chunkBytes, bytes: chunkBytes })),
      receivedBytes: oldCount * chunkBytes,
      complete: false,
      createdAt: 1,
      updatedAt: 1,
    }),
  )
  await f.run(() => sharedBlobMigration.up(() => {}))
  const next = await f.run(() =>
    Sharing.uploadBlob(f.credentials.alice, "blob-pages", {
      shareGeneration: 1,
      hash,
      offset: oldCount * chunkBytes,
      totalBytes: (oldCount + 2) * chunkBytes,
      bytes: new Uint8Array(chunkBytes),
    }),
  )
  expect(next).toMatchObject({
    complete: false,
    nextOffset: (oldCount + 1) * chunkBytes,
    receivedBytes: (oldCount + 1) * chunkBytes,
  })
  const header = await f.run(() => Storage.read(key))
  expect(header).toMatchObject({ schemaVersion: 2, receivedChunks: oldCount + 1 })
  expect(header).not.toHaveProperty("chunks")
  expect(JSON.stringify(header).length).toBeLessThan(1024)
  let count = 0
  await f.run(async () => {
    for await (const _ of Storage.records({ prefix: [...key, "chunk-manifest"], limit: 37 })) count++
  })
  expect(count).toBe(oldCount + 1)
}, 30000)

test("migration revalidates retained complete bytes for an authorized reader and revoked streams cannot emit later chunks", async () => {
  const { sharedBlobMigration } = await import("../src/shared-blob")
  await using f = await directoryFixture()
  await shared(f)
  const bytes = new Uint8Array([9, 0, 255, 10])
  const hash = createHash("sha256").update(bytes).digest("hex")
  await f.run(() =>
    Sharing.uploadBlob(f.credentials.alice, "blob-pages", {
      shareGeneration: 1,
      hash,
      offset: 0,
      totalBytes: bytes.length,
      bytes,
    }),
  )
  const key = Keys.sharedBlob("blob-pages", 1, hash)
  await f.run(() =>
    Storage.write(key, {
      schemaVersion: 1,
      sessionID: "blob-pages",
      shareGeneration: 1,
      hash,
      bytes: bytes.length,
      chunkBytes: 4 * 1024 * 1024,
      chunks: [{ offset: 0, bytes: bytes.length }],
      receivedBytes: bytes.length,
      complete: true,
      createdAt: 1,
      updatedAt: 1,
    }),
  )
  await f.run(() => sharedBlobMigration.up(() => {}))
  expect(
    (await f.run(() => Sharing.getBlobStatus(f.credentials.bob, "blob-pages", { shareGeneration: 1, hash }))).complete,
  ).toBe(false)
  const body = await f.run(() => Sharing.downloadBlob(f.credentials.bob, "blob-pages", { shareGeneration: 1, hash }))
  expect(new Uint8Array(await body.arrayBuffer())).toEqual(bytes)
  const revoked = await f.run(() => Sharing.downloadBlob(f.credentials.bob, "blob-pages", { shareGeneration: 1, hash }))
  await f.run(() => Sharing.unshare(f.credentials.alice, "blob-pages", { expectedShareGeneration: 1 }))
  await expect(revoked.arrayBuffer()).rejects.toThrow()
})

test("empty published blob bytes retain their exact hash and support a complete zero-length read", async () => {
  await using f = await directoryFixture()
  await shared(f)
  const bytes = new Uint8Array()
  const hash = createHash("sha256").digest("hex")
  expect(
    (
      await f.run(() =>
        Sharing.uploadBlob(f.credentials.alice, "blob-pages", {
          shareGeneration: 1,
          hash,
          offset: 0,
          totalBytes: 0,
          bytes,
        }),
      )
    ).complete,
  ).toBe(true)
  const response = await f.run(() =>
    Sharing.downloadBlob(f.credentials.bob, "blob-pages", { shareGeneration: 1, hash }),
  )
  expect((await response.arrayBuffer()).byteLength).toBe(0)
})

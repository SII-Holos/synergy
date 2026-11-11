import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { OrganizationRecoveryArchive } from "../../src/backup/archive"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { directoryFixture } from "../support/session-directory"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-recovery-"))
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "recovery-one", key }
    },
    async resolve(version: string) {
      if (version !== "recovery-one") throw new Error("Recovery key unavailable")
      return key
    },
  }
  return {
    root,
    keys,
    async [Symbol.asyncDispose]() {
      key.fill(0)
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
function file(name: string, bytes: Uint8Array) {
  return {
    path: name,
    bytes: bytes.length,
    sha256: hash(bytes),
    async *read() {
      for (let offset = 0; offset < bytes.length; offset += 65537) yield bytes.subarray(offset, offset + 65537)
    },
  }
}
async function* sources(files: ReturnType<typeof file>[]) {
  yield* files
}
async function* paths(root: string, relative = ""): AsyncGenerator<string> {
  const entries = await fs.opendir(path.join(root, relative))
  for await (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* paths(root, name)
    else yield name
  }
}

test("the operator archive encrypts all metadata and bytes and restores exact multi-chunk and empty files", async () => {
  await using f = await fixture()
  const bytes = new Uint8Array(4 * 1024 * 1024 + 19).map((_, index) => index % 251)
  const privateBody = new TextEncoder().encode("private-session-content-and-resource-credential")
  const directory = path.join(f.root, "archive")
  const sealed = await OrganizationRecoveryArchive.seal({
    directory,
    archiveID: "recovery-test",
    buildVersion: "fixture",
    keys: f.keys,
    files: sources([
      file("service/records.ndjson", privateBody),
      file("hosted/objects/content.bin", bytes),
      file("service/objects/empty.bin", new Uint8Array()),
    ]),
  })
  expect(sealed).toMatchObject({ fileCount: 3, bytes: bytes.length + privateBody.length })
  expect(await OrganizationRecoveryArchive.verify({ directory, keys: f.keys })).toEqual(sealed)
  expect(await Bun.file(path.join(directory, "archive.json")).text()).not.toContain("service/records.ndjson")
  for await (const name of paths(directory)) {
    const encoded = await Bun.file(path.join(directory, name)).text()
    expect(encoded).not.toContain("private-session-content-and-resource-credential")
    expect(encoded).not.toContain("hosted/objects/content.bin")
  }
  const outputDirectory = path.join(f.root, "opened")
  expect(await OrganizationRecoveryArchive.open({ directory, outputDirectory, keys: f.keys })).toEqual(sealed)
  expect(await Bun.file(path.join(outputDirectory, "service/records.ndjson")).text()).toBe(
    new TextDecoder().decode(privateBody),
  )
  expect(
    hash(new Uint8Array(await Bun.file(path.join(outputDirectory, "hosted/objects/content.bin")).arrayBuffer())),
  ).toBe(hash(bytes))
  expect((await fs.stat(path.join(outputDirectory, "service/objects/empty.bin"))).size).toBe(0)
})

test("paged archive inventories have no lifetime file quota and a failed writer never publishes a complete archive", async () => {
  await using f = await fixture()
  const files = Array.from({ length: 133 }, (_, index) =>
    file(`service/records/file-${index}.bin`, new Uint8Array([index % 251])),
  )
  const directory = path.join(f.root, "paged")
  const sealed = await OrganizationRecoveryArchive.seal({
    directory,
    archiveID: "paged",
    buildVersion: "fixture",
    keys: f.keys,
    files: sources(files),
  })
  expect(sealed.fileCount).toBe(133)
  expect(await OrganizationRecoveryArchive.verify({ directory, keys: f.keys })).toEqual(sealed)
  const failed = path.join(f.root, "failed")
  await expect(
    OrganizationRecoveryArchive.seal({
      directory: failed,
      archiveID: "failed",
      buildVersion: "fixture",
      keys: f.keys,
      files: sources([{ ...files[0]!, sha256: "0".repeat(64) }]),
    }),
  ).rejects.toThrow()
  expect(
    await fs.lstat(failed).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  await expect(
    OrganizationRecoveryArchive.seal({
      directory,
      archiveID: "existing",
      buildVersion: "fixture",
      keys: f.keys,
      files: sources([]),
    }),
  ).rejects.toThrow()
  expect(await OrganizationRecoveryArchive.verify({ directory, keys: f.keys })).toEqual(sealed)
})

test("wrong recovery keys, changed authenticated roots and substituted files never expose restored plaintext", async () => {
  await using f = await fixture()
  const directory = path.join(f.root, "archive")
  await OrganizationRecoveryArchive.seal({
    directory,
    archiveID: "bound",
    buildVersion: "fixture",
    keys: f.keys,
    files: sources([file("service/data.bin", new TextEncoder().encode("private fixture"))]),
  })
  const outputDirectory = path.join(f.root, "unavailable")
  await expect(
    OrganizationRecoveryArchive.open({
      directory,
      outputDirectory,
      keys: {
        ...f.keys,
        async resolve() {
          return new Uint8Array(32)
        },
      },
    }),
  ).rejects.toThrow()
  expect(
    await fs.lstat(outputDirectory).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  const root = path.join(directory, "archive.json")
  const original = await Bun.file(root).text()
  await Bun.write(root, original.replace('"bound"', '"foreign"'))
  await expect(OrganizationRecoveryArchive.verify({ directory, keys: f.keys })).rejects.toThrow()
  await Bun.write(root, original)
  const pages = path.join(directory, "pages")
  const page = path.join(pages, (await fs.readdir(pages))[0]!)
  const external = path.join(f.root, "external.json")
  await fs.rename(page, external)
  await fs.symlink(external, page)
  await expect(OrganizationRecoveryArchive.verify({ directory, keys: f.keys })).rejects.toThrow()
})

test("duplicate and escaping logical paths are rejected without overwriting another archive or destination", async () => {
  await using f = await fixture()
  const entry = file("service/data.bin", new Uint8Array([1]))
  for (const files of [
    [entry, entry],
    [{ ...entry, path: "../outside.bin" }],
    [{ ...entry, path: "service/con.bin" }],
  ]) {
    const directory = path.join(f.root, crypto.randomUUID())
    await expect(
      OrganizationRecoveryArchive.seal({
        directory,
        archiveID: "invalid",
        buildVersion: "fixture",
        keys: f.keys,
        files: sources(files),
      }),
    ).rejects.toThrow()
    expect(
      await fs.lstat(directory).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  }
  const directory = path.join(f.root, "archive")
  await OrganizationRecoveryArchive.seal({
    directory,
    archiveID: "valid",
    buildVersion: "fixture",
    keys: f.keys,
    files: sources([entry]),
  })
  const outputDirectory = path.join(f.root, "existing")
  await fs.mkdir(outputDirectory)
  await Bun.write(path.join(outputDirectory, "keep"), "existing destination")
  await expect(OrganizationRecoveryArchive.open({ directory, outputDirectory, keys: f.keys })).rejects.toThrow()
  expect(await Bun.file(path.join(outputDirectory, "keep")).text()).toBe("existing destination")
})

test("a missing later ciphertext chunk removes the private opened staging and archive identity prevents chunk substitution", async () => {
  await using f = await fixture()
  const directory = path.join(f.root, "archive")
  const bytes = new Uint8Array(4 * 1024 * 1024 + 3).fill(7)
  await OrganizationRecoveryArchive.seal({
    directory,
    archiveID: "original",
    buildVersion: "fixture",
    keys: f.keys,
    files: sources([file("service/data.bin", bytes)]),
  })
  const fileRoot = path.join(directory, "content", (await fs.readdir(path.join(directory, "content")))[0]!)
  const chunks = (await fs.readdir(fileRoot)).sort()
  await fs.rm(path.join(fileRoot, chunks[1]!))
  const outputDirectory = path.join(f.root, "incomplete")
  await expect(OrganizationRecoveryArchive.open({ directory, outputDirectory, keys: f.keys })).rejects.toThrow()
  expect(
    await fs.lstat(outputDirectory).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  const other = path.join(f.root, "other")
  await OrganizationRecoveryArchive.seal({
    directory: other,
    archiveID: "foreign",
    buildVersion: "fixture",
    keys: f.keys,
    files: sources([file("service/data.bin", bytes)]),
  })
  const otherRoot = path.join(other, "content", (await fs.readdir(path.join(other, "content")))[0]!)
  await fs.copyFile(path.join(otherRoot, chunks[0]!), path.join(fileRoot, chunks[0]!))
  await expect(OrganizationRecoveryArchive.verify({ directory, keys: f.keys })).rejects.toThrow("authentication")
  await expect(
    OrganizationRecoveryArchive.open({
      directory: other,
      outputDirectory: path.join(other, "plaintext"),
      keys: f.keys,
    }),
  ).rejects.toThrow("independent")
})

test("encrypted transport preserves an actual canonical namespace for its native independent-Home restore", async () => {
  await using f = await fixture()
  await using source = await directoryFixture()
  const bytes = new Uint8Array(65539).map((_, index) => index % 251)
  const capture = path.join(f.root, "native-source")
  await source.run(async () => {
    await Storage.write(["private-fixture", "body"], {
      privateBody: "fixture-private-canonical-body",
      future: { retained: [1, 2] },
    })
    await Storage.write(["credential-fixture"], { value: "fixture-recovery-credential" })
    await Storage.writeBinary(["binary-fixture"], bytes)
    await StorageCheckpoint.exportArchive({
      directory: capture,
      archiveID: "captured-native",
      namespaceID: "service",
      buildVersion: "fixture",
      keys: f.keys,
      protect: (entry) => entry.type === "record" && entry.key[0] === "credential-fixture",
    })
  })
  async function* capturedFiles() {
    for await (const name of paths(capture))
      yield file(`namespaces/service/${name}`, new Uint8Array(await Bun.file(path.join(capture, name)).arrayBuffer()))
  }
  const encrypted = path.join(f.root, "encrypted")
  await OrganizationRecoveryArchive.seal({
    directory: encrypted,
    archiveID: "complete-container",
    buildVersion: "fixture",
    keys: f.keys,
    files: capturedFiles(),
  })
  const opened = path.join(f.root, "opened")
  await OrganizationRecoveryArchive.open({ directory: encrypted, outputDirectory: opened, keys: f.keys })
  const namespace = path.join(opened, "namespaces/service")
  expect((await StorageCheckpoint.verifyArchive({ directory: namespace, keys: f.keys })).artifactReferences).toBe(1)
  const home = path.join(f.root, "target-home")
  const context = RuntimeContext.create({
    home,
    root: path.join(home, ".synergy"),
    env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
  })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "restored-service",
    filename: path.join(home, "db"),
  })
  context.storage = { store, artifactDirectory: path.join(home, "content") }
  try {
    await context.run(async () => {
      await StorageCheckpoint.restoreArchive({
        directory: namespace,
        keys: f.keys,
        restoreID: "native-restore",
        finalize: async (tx) => {
          await tx.write(["fixture-recovery-fence"], { executionAllowed: false })
        },
      })
      expect(await Storage.read(["private-fixture", "body"])).toEqual({
        privateBody: "fixture-private-canonical-body",
        future: { retained: [1, 2] },
      })
      expect(await Storage.read(["credential-fixture"])).toEqual({ value: "fixture-recovery-credential" })
      expect(hash(await Storage.readBinary(["binary-fixture"]))).toBe(hash(bytes))
      expect(await Storage.read(["fixture-recovery-fence"])).toEqual({ executionAllowed: false })
    })
  } finally {
    await context.run(async () => {
      ObservabilityMetrics.stop()
      await ObservabilityStore.stop()
      await store.close()
    })
    context.dispose()
  }
})

test("cancellation closes the actual source iterator and removes only its incomplete encrypted output", async () => {
  await using f = await fixture()
  const directory = path.join(f.root, "cancelled")
  const controller = new AbortController()
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1).fill(3)
  let closed = false
  const entry = {
    ...file("service/data.bin", bytes),
    async *read() {
      try {
        yield bytes.subarray(0, 4 * 1024 * 1024)
        controller.abort(new Error("Fixture capture cancelled"))
        yield bytes.subarray(4 * 1024 * 1024)
      } finally {
        closed = true
      }
    },
  }
  await expect(
    OrganizationRecoveryArchive.seal({
      directory,
      archiveID: "cancelled",
      buildVersion: "fixture",
      keys: f.keys,
      files: sources([entry]),
      signal: controller.signal,
    }),
  ).rejects.toThrow("capture cancelled")
  expect(closed).toBe(true)
  expect(
    await fs.lstat(directory).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  const late = new AbortController()
  const lateDirectory = path.join(f.root, "late-cancelled")
  const last = new Uint8Array([9])
  const lateEntry = {
    ...file("service/last.bin", last),
    async *read() {
      yield last
      late.abort(new Error("Fixture final capture cancelled"))
    },
  }
  await expect(
    OrganizationRecoveryArchive.seal({
      directory: lateDirectory,
      archiveID: "late",
      buildVersion: "fixture",
      keys: f.keys,
      files: sources([lateEntry]),
      signal: late.signal,
    }),
  ).rejects.toThrow("final capture cancelled")
  expect(
    await fs.lstat(lateDirectory).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

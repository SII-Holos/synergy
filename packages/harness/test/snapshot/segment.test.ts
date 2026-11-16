import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { storageTestRuntime } from "../support/storage-runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { StoragePath } from "../../src/storage/path"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { StoredSnapshotContent as Content } from "../../src/session/stored-snapshot-content"
import { StorageCheckpoint } from "../../src/storage/checkpoint"
import { testRuntime } from "../support/runtime"

async function fixture(external = false) {
  const runtime = await storageTestRuntime()
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "snapshot-segment-"))
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory, "store.sqlite"),
    namespace: "runtime",
  })
  const handle = { store, artifactDirectory: path.join(directory, "content") }
  if (external) runtime.run(() => SnapshotStore.registerStorage(storedSnapshots()))
  return {
    directory,
    handle,
    run: <T>(body: () => Promise<T>) => runtime.run(() => Storage.provide(handle, body)),
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await store.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

test("a Snapshot segment restores native and legacy exact refs and unclassified objects into an independent Home", async () => {
  await using source = await fixture()
  await using target = await fixture()
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const saved = await source.run(async () => {
    const operation = await SnapshotStore.resolveRepository("scope", "session")
    await SnapshotStore.initialize(operation)
    const blob = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Native retained bytes",
    )
    const binary = randomBytes(4 * 1024 * 1024 + 17)
    const filename = path.join(source.directory, "binary")
    await fs.writeFile(filename, binary)
    const binaryBlob = await SnapshotStore.command(operation.repository, ["hash-object", "-w", filename])
    const root = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${binaryBlob}\tfile.bin\n100644 blob ${blob}\tfile.txt\n`,
    )
    await SnapshotStore.retainMany("scope", "session", [root])
    const orphan = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Unclassified immutable bytes",
    )
    await SnapshotGit.checked(operation.repository, ["update-ref", "refs/custom/retained", root])
    await SnapshotGit.checked(operation.repository, ["symbolic-ref", "refs/custom/symbolic", "refs/custom/retained"])
    await fs.writeFile(path.join(operation.repository, "HEAD"), "ref: refs/heads/unborn-fixture\r\n")
    const legacyRepository = SnapshotStore.legacyRepository("scope", "legacy")
    await SnapshotStore.initializeBareRepository(legacyRepository)
    const legacyBlob = await SnapshotStore.command(
      legacyRepository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Legacy retained bytes",
    )
    const legacyRoot = await SnapshotStore.command(
      legacyRepository,
      ["mktree"],
      undefined,
      `100644 blob ${legacyBlob}\tlegacy.txt\n`,
    )
    await SnapshotGit.checked(legacyRepository, ["update-ref", "refs/custom/legacy", legacyRoot])
    await Storage.write(StoragePath.snapshotOwner("scope", "legacy"), {
      version: 3,
      backend: "legacy",
      retentionID: "legacy",
    })
    return SnapshotMaintenance.withCapture(async (capture) => {
      const namespace = await capture.exportArchive({
        directory: path.join(source.directory, "namespace"),
        archiveID: "source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      const segment = await capture.exportSnapshots({
        archive: namespace,
        directory: path.join(source.directory, "snapshots"),
      })
      return { namespace: namespace.namespace, segment, root, orphan, legacyRoot, binary }
    })
  })
  await fs.rm(source.handle.artifactDirectory, { recursive: true, force: true })
  await target.run(() =>
    SnapshotMaintenance.withRestoredSegment(
      { directory: saved.segment.directory, expected: saved.segment.namespace, source: saved.namespace, keys },
      async (prepared) => {
        let repositories = 0
        for await (const item of prepared.repositories()) {
          repositories++
          if (item.info.layout === "native") {
            expect(await SnapshotGit.checked(item.repository, ["show", `${saved.root}:file.txt`])).toBe(
              "Native retained bytes",
            )
            const restored = await SnapshotGit.run(
              ["git", "--git-dir", item.repository, "show", `${saved.root}:file.bin`],
              path.dirname(item.repository),
            )
            expect(restored.exitCode).toBe(0)
            expect(restored.bytes).toEqual(saved.binary)
            expect(await fs.readFile(path.join(item.repository, "HEAD"), "utf8")).toBe(
              "ref: refs/heads/unborn-fixture\r\n",
            )
            expect(await SnapshotGit.checked(item.repository, ["cat-file", "blob", saved.orphan])).toBe(
              "Unclassified immutable bytes",
            )
            expect(await SnapshotGit.checked(item.repository, ["rev-parse", "refs/custom/retained"])).toBe(saved.root)
            expect(await SnapshotGit.checked(item.repository, ["symbolic-ref", "refs/custom/symbolic"])).toBe(
              "refs/custom/retained",
            )
          } else if (item.info.layout === "legacy") {
            expect(await SnapshotGit.checked(item.repository, ["show", `${saved.legacyRoot}:legacy.txt`])).toBe(
              "Legacy retained bytes",
            )
            expect(await SnapshotGit.checked(item.repository, ["rev-parse", "refs/custom/legacy"])).toBe(
              saved.legacyRoot,
            )
          }
        }
        expect(repositories).toBe(2)
      },
    ),
  )
})

test("a stored Snapshot segment reconstructs the exact archived graph after live headers and cache change", async () => {
  await using source = await fixture(true)
  await using target = await fixture()
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const saved = await source.run(async () => {
    const operation = await SnapshotStore.resolveRepository("scope", "session")
    await SnapshotStore.initialize(operation)
    const bytes = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Fixed archived stored graph",
    )
    const root = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${bytes}\tfile.txt\n`,
    )
    await SnapshotStore.retainMany("scope", "session", [root])
    return SnapshotMaintenance.withCapture(async (capture) => {
      const namespace = await capture.exportArchive({
        directory: path.join(source.directory, "namespace"),
        archiveID: "stored",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      await Storage.removeTree(Content.key("scope", "session", root))
      await fs.rm(operation.repository, { recursive: true, force: true })
      await SnapshotStore.initializeBareRepository(operation.repository)
      const live = await SnapshotStore.command(
        operation.repository,
        ["hash-object", "-w", "--stdin"],
        undefined,
        "Unselected live cache bytes",
      )
      const segment = await capture.exportSnapshots({
        archive: namespace,
        directory: path.join(source.directory, "snapshots"),
      })
      return { namespace: namespace.namespace, segment, root, live }
    })
  })
  await fs.rm(source.handle.artifactDirectory, { recursive: true, force: true })
  await target.run(() =>
    SnapshotMaintenance.withRestoredSegment(
      { directory: saved.segment.directory, expected: saved.segment.namespace, source: saved.namespace, keys },
      async (prepared) => {
        let repositories = 0
        for await (const item of prepared.repositories()) {
          repositories++
          expect(item.info.layout).toBe("stored")
          expect(await SnapshotGit.checked(item.repository, ["show", `${saved.root}:file.txt`])).toBe(
            "Fixed archived stored graph",
          )
          await expect(SnapshotGit.checked(item.repository, ["cat-file", "-e", saved.live])).rejects.toThrow()
        }
        expect(repositories).toBe(1)
      },
    ),
  )
})

test("empty captures reject cloned archive handles and restore binds the segment to its actual parent namespace", async () => {
  await using source = await fixture()
  await using target = await fixture()
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const saved = await source.run(() =>
    SnapshotMaintenance.withCapture(async (capture) => {
      await Storage.write(["fixture", "source"], { selected: true })
      const namespace = await capture.exportArchive({
        directory: path.join(source.directory, "namespace"),
        archiveID: "source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      await expect(
        (async () =>
          capture.exportSnapshots({ archive: { ...namespace }, directory: path.join(source.directory, "forged") }))(),
      ).rejects.toThrow("own exported")
      expect(await Bun.file(path.join(source.directory, "forged", "manifest.json")).exists()).toBeFalse()
      const segment = await capture.exportSnapshots({
        archive: namespace,
        directory: path.join(source.directory, "snapshots"),
      })
      await Storage.write(["fixture", "source"], { selected: false })
      const other = await StorageCheckpoint.exportArchive({
        directory: path.join(source.directory, "other"),
        archiveID: "other",
        namespaceID: "other-runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      return { namespace: namespace.namespace, segment, other }
    }),
  )
  let entered = false
  await target.run(async () => {
    await expect(
      SnapshotMaintenance.withRestoredSegment(
        { directory: saved.segment.directory, expected: saved.segment.namespace, source: saved.other, keys },
        async () => {
          entered = true
        },
      ),
    ).rejects.toThrow("another namespace")
    expect(entered).toBeFalse()
    await SnapshotMaintenance.withRestoredSegment(
      { directory: saved.segment.directory, expected: saved.segment.namespace, source: saved.namespace, keys },
      async (prepared) => {
        expect(await Array.fromAsync(prepared.repositories())).toEqual([])
      },
    )
  })
})

test("missing segment pack bytes and incomplete restored readers cannot expose a verified private repository set", async () => {
  await using source = await fixture()
  await using target = await fixture()
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const saved = await source.run(async () => {
    const operation = await SnapshotStore.resolveRepository("scope", "session")
    await SnapshotStore.initialize(operation)
    const blob = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Verified repository set",
    )
    const root = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${blob}\tfile.txt\n`,
    )
    await SnapshotStore.retainMany("scope", "session", [root])
    return SnapshotMaintenance.withCapture(async (capture) => {
      const namespace = await capture.exportArchive({
        directory: path.join(source.directory, "namespace"),
        archiveID: "source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      return {
        namespace: namespace.namespace,
        segment: await capture.exportSnapshots({
          archive: namespace,
          directory: path.join(source.directory, "snapshots"),
        }),
      }
    })
  })
  await target.run(async () => {
    const input = {
      directory: saved.segment.directory,
      expected: saved.segment.namespace,
      source: saved.namespace,
      keys,
    }
    await expect(
      SnapshotMaintenance.withRestoredSegment(input, async (prepared) => {
        for await (const _item of prepared.repositories()) break
      }),
    ).rejects.toThrow("must complete")
    let escaped: AsyncGenerator<unknown> | undefined
    await expect(
      SnapshotMaintenance.withRestoredSegment(input, async (prepared) => {
        escaped = prepared.repositories()
        await escaped.next()
      }),
    ).rejects.toThrow("unfinished readers")
    if (!escaped) throw new Error("No escaped reader was captured")
    expect((await escaped.next()).done).toBeTrue()
    let pack: { sha256: string } | undefined
    for await (const entry of StorageCheckpoint.entries({
      directory: saved.segment.directory,
      expected: saved.segment.namespace,
      keys,
    }))
      if (entry.type === "artifact") pack = { sha256: entry.location.sha256 }
    if (!pack) throw new Error("Segment pack was not retained")
    await Storage.writeBinary(["foreign", "bytes"], randomBytes(4096))
    const foreignDirectory = path.join(target.directory, "foreign-namespace")
    const foreignManifest = await StorageCheckpoint.exportArchive({
      directory: foreignDirectory,
      archiveID: "foreign",
      namespaceID: "foreign-runtime",
      buildVersion: "fixture",
      keys,
      protect: () => true,
    })
    let foreignPack: string | undefined
    for await (const entry of StorageCheckpoint.entries({
      directory: foreignDirectory,
      expected: foreignManifest,
      keys,
    }))
      if (entry.type === "artifact")
        foreignPack = path.join(foreignDirectory, "objects", `${entry.location.sha256}.bin`)
    if (!foreignPack) throw new Error("A genuine foreign namespace artifact is missing")
    await fs.copyFile(foreignPack, path.join(saved.segment.directory, "objects", `${pack.sha256}.bin`))
    let exposed = false
    await expect(
      SnapshotMaintenance.withRestoredSegment(input, async () => {
        exposed = true
      }),
    ).rejects.toThrow("integrity")
    expect(exposed).toBeFalse()
    await fs.rm(path.join(saved.segment.directory, "objects", `${pack.sha256}.bin`))
    let entered = false
    await expect(
      SnapshotMaintenance.withRestoredSegment(input, async () => {
        entered = true
      }),
    ).rejects.toThrow()
    expect(entered).toBeFalse()
  })
})

test("valid stored chunk hashes with the wrong Git graph cannot complete a Snapshot segment", async () => {
  await using source = await fixture(true)
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  await source.run(async () => {
    const operation = await SnapshotStore.resolveRepository("scope", "session")
    await SnapshotStore.initialize(operation)
    const tree = async (text: string) => {
      const blob = await SnapshotStore.command(operation.repository, ["hash-object", "-w", "--stdin"], undefined, text)
      const root = await SnapshotStore.command(
        operation.repository,
        ["mktree"],
        undefined,
        `100644 blob ${blob}\tfile.txt\n`,
      )
      await SnapshotStore.retainMany("scope", "session", [root])
      return root
    }
    const expected = await tree("Expected retained tree")
    const other = await tree("Another retained tree")
    const manifest = Content.Header.parse(await Content.read("scope", "session", other))
    const writer = new Content.Writer("scope", "session", expected, "wrong-graph", "chunks-v2")
    for await (const ref of Content.references({ scopeID: "scope", retentionID: "session", manifest })) {
      await Storage.transaction(async (tx) => {
        const location = await tx.artifact(ref.key)
        if (!location) throw new Error("Fixture content is unavailable")
        await tx.writeArtifacts([
          {
            key: Content.chunkKey("scope", "session", { ...manifest, root: expected, contentID: "wrong-graph" }, ref),
            location,
          },
        ])
      })
      await writer.append({ pack: ref.pack, index: ref.index, sha256: ref.sha256, bytes: ref.bytes })
    }
    await Storage.write([...Content.key("scope", "session", expected), "manifest"], await writer.seal())
    await SnapshotMaintenance.withCapture(async (capture) => {
      const namespace = await capture.exportArchive({
        directory: path.join(source.directory, "namespace"),
        archiveID: "source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      await expect(
        capture.exportSnapshots({ archive: namespace, directory: path.join(source.directory, "snapshots") }),
      ).rejects.toThrow()
      expect(await Bun.file(path.join(source.directory, "snapshots", "manifest.json")).exists()).toBeFalse()
    })
  })
})

test("cancellation during actual segment pack reading drains preparation before exposing any restored repository", async () => {
  await using source = await fixture()
  await using target = await fixture()
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const saved = await source.run(async () => {
    const operation = await SnapshotStore.resolveRepository("scope", "session")
    await SnapshotStore.initialize(operation)
    const blob = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Cancelled native pack reader",
    )
    const root = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${blob}\tfile.txt\n`,
    )
    await SnapshotStore.retainMany("scope", "session", [root])
    return SnapshotMaintenance.withCapture(async (capture) => {
      const namespace = await capture.exportArchive({
        directory: path.join(source.directory, "namespace"),
        archiveID: "source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      return {
        namespace: namespace.namespace,
        segment: await capture.exportSnapshots({
          archive: namespace,
          directory: path.join(source.directory, "snapshots"),
        }),
      }
    })
  })
  await target.run(async () => {
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const reason = new Error("Cancel this actual Snapshot pack preparation")
    const stream = StorageCheckpoint.streamArtifact
    let drained = false
    const barrier = spyOn(StorageCheckpoint, "streamArtifact").mockImplementation(async function* (input) {
      try {
        for await (const bytes of stream(input)) {
          entered.resolve()
          await new Promise<void>((_resolve, reject) => {
            if (input.signal?.aborted) reject(input.signal.reason)
            else input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true })
          })
          yield bytes
        }
      } finally {
        drained = true
      }
    })
    let exposed = false
    const restoring = SnapshotMaintenance.withRestoredSegment(
      {
        directory: saved.segment.directory,
        expected: saved.segment.namespace,
        source: saved.namespace,
        keys,
        signal: controller.signal,
      },
      async () => {
        exposed = true
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    const rescue = setTimeout(() => controller.abort(new Error("Fixture pack reader did not reach its barrier")), 5000)
    try {
      await entered.promise
      controller.abort(reason)
      expect(await restoring).toBe(reason)
      expect(drained).toBeTrue()
      expect(exposed).toBeFalse()
    } finally {
      clearTimeout(rescue)
      controller.abort(reason)
      await restoring
      barrier.mockRestore()
    }
  })
})

test("private Snapshot restoration excludes the receiving Host's configured Git template objects and refs", async () => {
  await using source = await fixture()
  const key = randomBytes(32)
  const keys = {
    async current() {
      return { version: "fixture", key }
    },
    async resolve() {
      return key
    },
  }
  const template = path.join(source.directory, "git-template")
  const saved = await source.run(async () => {
    await SnapshotStore.initializeBareRepository(template)
    const blob = await SnapshotStore.command(
      template,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Unrelated receiving Host template data",
    )
    const templateRoot = await SnapshotStore.command(
      template,
      ["mktree"],
      undefined,
      `100644 blob ${blob}\tforeign.txt\n`,
    )
    await SnapshotGit.checked(template, ["update-ref", "refs/custom/template", templateRoot])
    const operation = await SnapshotStore.resolveRepository("scope", "session")
    await SnapshotStore.initialize(operation)
    const incoming = await SnapshotStore.command(
      operation.repository,
      ["hash-object", "-w", "--stdin"],
      undefined,
      "Incoming archive data",
    )
    const root = await SnapshotStore.command(
      operation.repository,
      ["mktree"],
      undefined,
      `100644 blob ${incoming}\tfile.txt\n`,
    )
    await SnapshotStore.retainMany("scope", "session", [root])
    return SnapshotMaintenance.withCapture(async (capture) => {
      const namespace = await capture.exportArchive({
        directory: path.join(source.directory, "namespace"),
        archiveID: "source",
        namespaceID: "runtime",
        buildVersion: "fixture",
        keys,
        protect: () => true,
      })
      return {
        namespace: namespace.namespace,
        segment: await capture.exportSnapshots({
          archive: namespace,
          directory: path.join(source.directory, "snapshots"),
        }),
        blob,
      }
    })
  })
  const receiver = path.join(source.directory, "receiving-user")
  await fs.mkdir(receiver)
  const hooks = path.join(receiver, "hooks")
  const marker = path.join(receiver, "hook-executed")
  const quotedMarker = "'" + marker.split(path.sep).join("/").replaceAll("'", "'\\''") + "'"
  await fs.mkdir(hooks)
  await fs.writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\nprintf 'executed' > ${quotedMarker}\n`, {
    mode: 0o700,
  })
  await fs.writeFile(
    path.join(receiver, ".gitconfig"),
    `[init]\n\ttemplateDir = ${JSON.stringify(template)}\n[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`,
  )
  await using target = await testRuntime({ env: { HOME: receiver, XDG_CONFIG_HOME: receiver } })
  await target.run(() =>
    SnapshotMaintenance.withRestoredSegment(
      { directory: saved.segment.directory, expected: saved.segment.namespace, source: saved.namespace, keys },
      async (prepared) => {
        for await (const item of prepared.repositories()) {
          await expect(
            SnapshotGit.checked(item.repository, ["rev-parse", "--verify", "refs/custom/template"]),
          ).rejects.toThrow()
          await expect(SnapshotGit.checked(item.repository, ["cat-file", "-e", saved.blob])).rejects.toThrow()
          expect(await Bun.file(marker).exists()).toBeFalse()
        }
      },
    ),
  )
  await target.run(async () => {
    const ordinary = path.join(receiver, "ordinary.git")
    await SnapshotStore.initializeBareRepository(ordinary)
    await SnapshotGit.checked(ordinary, ["update-ref", "refs/custom/ordinary", saved.blob])
    expect(await Bun.file(marker).exists()).toBeTrue()
  })
})

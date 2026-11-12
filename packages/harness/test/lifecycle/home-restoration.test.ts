import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { fileLockPath, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { RuntimeContext } from "../../src/lifecycle/context"
import { HomeRestoration } from "../../src/lifecycle/home-restoration"
import { Storage } from "../../src/storage/storage"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { ServerProcessLock } from "../../src/util/server-process-lock"
import { storageTestRuntime } from "../support/storage-runtime"

const request = {
  restoreID: "restore-test",
  owner: "organization",
  sourceHash: "a".repeat(64),
  payload: { namespaceID: "service", recordsHash: "b".repeat(64) },
}
async function fixture(home?: string, database = "restore.sqlite", sealed = false) {
  const selectedHome = await fs.realpath(
    home ?? (await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "home-restore-"))),
  )
  const runtime = await storageTestRuntime({ home: selectedHome })
  runtime.run(() => {
    HomeRestoration.register()
    if (sealed) RuntimeContext.sealComposition()
  })
  const root = path.join(selectedHome, ".synergy")
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "restoration",
    filename: path.join(root, "data", database),
  })
  const lock = await runtime.run(async () => {
    RuntimeContext.current().storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
    return ServerProcessLock.acquire()
  })
  return {
    home: selectedHome,
    root,
    run: runtime.run,
    store,
    async close() {
      await store.close()
      await runtime.run(() => lock.release())
      await runtime.close()
    },
  }
}

test("a native Home installation retains its first incarnation across a lost acknowledgement and cold retry", async () => {
  const first = await fixture()
  const filename = path.join(first.root, "home-restoration.json")
  let saved: HomeRestoration.Info
  try {
    const write = AtomicFile.writeJsonAtomic
    const lost = new Error("installation acknowledgement lost")
    const intercepted = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(async (...args) => {
      await write(...args)
      if (args[0] === filename) throw lost
    })
    try {
      await expect(first.run(() => HomeRestoration.begin(request))).rejects.toBe(lost)
    } finally {
      intercepted.mockRestore()
    }
    const { target: _, ...persisted } = await Bun.file(filename).json()
    saved = HomeRestoration.Info.parse(persisted)
    expect(saved.phase).toBe("staging")
    expect(saved.incarnation).not.toBe("deployment")
    await first.run(async () => {
      const target = await HomeRestoration.begin(request)
      expect(await HomeRestoration.inspect(target)).toEqual(saved)
      await expect(HomeRestoration.begin({ ...request, sourceHash: "c".repeat(64) })).rejects.toThrow("different")
      await expect(HomeRestoration.begin({ ...request, payload: { namespaceID: "another" } })).rejects.toThrow(
        "different",
      )
      await expect(HomeRestoration.assertOrdinaryStartup()).rejects.toThrow("restoration")
    })
  } finally {
    await first.close()
  }
  const second = await fixture(first.home)
  try {
    await second.run(async () => {
      const target = await HomeRestoration.begin(request)
      expect(await HomeRestoration.inspect(target)).toEqual(saved!)
    })
  } finally {
    await second.close()
    await fs.rm(first.home, { recursive: true, force: true })
  }
})

test("installation permits belong to the actual target Store, concrete artifacts and callback lifetime", async () => {
  const first = await fixture()
  const second = await fixture()
  try {
    let expired: HomeRestoration.InstallPermit | undefined
    await first.run(async () => {
      const target = await HomeRestoration.begin(request)
      await HomeRestoration.withTarget(target, async (permit) => {
        expired = permit
        await HomeRestoration.verifyCurrent(permit)
        await expect(second.run(() => HomeRestoration.verifyCurrent(permit))).rejects.toThrow("Runtime")
        const handle = Storage.current()
        const artifacts = handle.artifactDirectory
        handle.artifactDirectory = path.join(first.root, "other-artifacts")
        try {
          expect(() => HomeRestoration.assertCurrent(permit)).toThrow("artifact")
        } finally {
          handle.artifactDirectory = artifacts
        }
      })
      expect(() => HomeRestoration.assertCurrent(expired!)).toThrow("callback")
      await expect(HomeRestoration.verifyCurrent({ kind: "home-installation" })).rejects.toThrow("native")
    })
  } finally {
    await first.close()
    await second.close()
    await fs.rm(first.home, { recursive: true, force: true })
    await fs.rm(second.home, { recursive: true, force: true })
  }
})

test("cancellation while the native installation lock is held retains the original reason without waiting for release", async () => {
  const selected = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = withFileLock(
    { directory: path.join(selected.root, "state", ".locks"), key: "home-restoration" },
    async () => {
      entered.resolve()
      await release.promise
    },
  )
  await entered.promise
  const attempted = Promise.withResolvers<void>()
  const open = fs.open
  const lockPath = fileLockPath(path.join(selected.root, "state", ".locks"), "home-restoration")
  const observed = spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === lockPath && args[1] === "wx") attempted.resolve()
    return open(...args)
  })
  const abort = new AbortController()
  const reason = new Error("cancel installation admission")
  let outcome: unknown
  const pending = selected
    .run(() => HomeRestoration.begin(request, { signal: abort.signal }))
    .catch((error) => {
      outcome = error
    })
  try {
    await attempted.promise
    abort.abort(reason)
    await Promise.race([pending, Bun.sleep(500)])
    expect(outcome).toBe(reason)
    expect(await Bun.file(path.join(selected.root, "home-restoration.json")).exists()).toBe(false)
  } finally {
    observed.mockRestore()
    release.resolve()
    await held
    await pending
    await selected.close()
    await fs.rm(selected.home, { recursive: true, force: true })
  }
})

test("an unowned nonempty target cannot acquire a fresh restoration identity", async () => {
  const selected = await fixture()
  try {
    await selected.run(async () => {
      await Storage.write(["existing", "canonical"], { retained: true })
      await expect(HomeRestoration.begin(request)).rejects.toThrow("empty")
      expect(await Bun.file(path.join(selected.root, "home-restoration.json")).exists()).toBe(false)
      expect(await Storage.read(["existing", "canonical"])).toEqual({ retained: true })
      await Storage.write(["unrelated", "after-rejection"], { usable: true })
      expect(await Storage.read(["unrelated", "after-rejection"])).toEqual({ usable: true })
    })
  } finally {
    await selected.close()
    await fs.rm(selected.home, { recursive: true, force: true })
  }
})

test("installation admission operates after composition seals before the actual Store is attached", async () => {
  const selected = await fixture(undefined, "restore.sqlite", true)
  try {
    await selected.run(async () => {
      const target = await HomeRestoration.begin(request)
      expect((await HomeRestoration.inspect(target)).phase).toBe("staging")
    })
  } finally {
    await selected.close()
    await fs.rm(selected.home, { recursive: true, force: true })
  }
})

test("cold retry cannot substitute a different native database under the same Home", async () => {
  const first = await fixture()
  try {
    await first.run(() => HomeRestoration.begin(request))
  } finally {
    await first.close()
  }
  const changed = await fixture(first.home, "other.sqlite")
  try {
    await expect(changed.run(() => HomeRestoration.begin(request))).rejects.toThrow("different")
  } finally {
    await changed.close()
    await fs.rm(first.home, { recursive: true, force: true })
  }
})

test("the installation file lease excludes ordinary writes and retains exact native directories", async () => {
  const selected = await fixture()
  try {
    await selected.run(async () => {
      const target = await HomeRestoration.begin(request)
      await expect(Storage.write(["unowned", "tail"], 1)).rejects.toThrow("restoration")
      await HomeRestoration.withTarget(target, async (permit) => {
        await Storage.write(["owned", "staged"], 2)
        await Storage.writeBinary(["owned", "binary"], Buffer.from("prepared target bytes"))
        await HomeRestoration.verifyCurrent(permit)
        const original = path.join(selected.home, "original-root")
        await fs.rename(selected.root, original)
        await fs.mkdir(selected.root)
        try {
          await expect(HomeRestoration.verifyCurrent(permit)).rejects.toThrow("identity")
        } finally {
          await fs.rmdir(selected.root)
          await fs.rename(original, selected.root)
        }
      })
      expect(await Storage.read(["owned", "staged"])).toBe(2)
      expect(await Storage.readBinary(["owned", "binary"])).toEqual(Buffer.from("prepared target bytes"))
    })
  } finally {
    await selected.close()
    await fs.rm(selected.home, { recursive: true, force: true })
  }
})

test("cold object backends with the same writer label need their actual reconstruction owner", async () => {
  const first = await fixture()
  const backend = async (name: string) => {
    const directory = path.join(first.home, name)
    await fs.mkdir(directory)
    return {
      async put(hash: string, bytes: Uint8Array) {
        await fs.writeFile(path.join(directory, hash), bytes)
      },
      async get(hash: string, maximum: number) {
        const bytes = await fs.readFile(path.join(directory, hash))
        if (bytes.byteLength > maximum) throw new Error("bounded object read")
        return bytes
      },
      async delete(hash: string) {
        await fs.rm(path.join(directory, hash), { force: true })
      },
    }
  }
  const original = await backend("objects-one")
  const replacement = await backend("objects-two")
  await original.put("one", Buffer.from("original bytes"))
  await replacement.put("one", Buffer.from("different bytes"))
  let originalDenied = false
  let replacementDenied = false
  try {
    await first.run(async () => {
      Storage.current().artifactObjects = { blobs: original, writerID: "same-writer" }
      try {
        await HomeRestoration.begin(request)
      } catch (error) {
        originalDenied = error instanceof Error && error.message.includes("reconstruction")
      }
    })
  } finally {
    await first.close()
  }
  const cold = await fixture(first.home)
  try {
    await cold.run(async () => {
      Storage.current().artifactObjects = { blobs: replacement, writerID: "same-writer" }
      try {
        await HomeRestoration.begin(request)
      } catch (error) {
        replacementDenied = error instanceof Error && error.message.includes("reconstruction")
      }
    })
    expect(originalDenied).toBe(true)
    expect(replacementDenied).toBe(true)
  } finally {
    await cold.close()
    await fs.rm(first.home, { recursive: true, force: true })
  }
})

test("an existing local artifact directory cannot be replaced between installation callbacks", async () => {
  const selected = await fixture()
  const artifacts = path.join(selected.root, "data", "artifacts")
  const original = path.join(selected.root, "data", "original-artifacts")
  await fs.mkdir(artifacts)
  try {
    await selected.run(async () => {
      const target = await HomeRestoration.begin(request)
      await fs.rename(artifacts, original)
      await fs.mkdir(artifacts)
      await expect(HomeRestoration.withTarget(target, async () => {})).rejects.toThrow("identity")
    })
  } finally {
    await selected.close()
    await fs.rm(selected.home, { recursive: true, force: true })
  }
})

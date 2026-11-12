import { expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { FileAtomicWrite } from "../../src/file/atomic-write"

const supported = ["darwin", "linux"].includes(process.platform)

test.skipIf(!supported)(
  "anchored atomic publication writes the retained directory after its pathname is replaced",
  async () => {
    await using temporary = await tmpdir()
    const root = path.join(temporary.path, "root")
    const retained = path.join(temporary.path, "retained")
    await fs.promises.mkdir(root)
    await FileAtomicWrite.withRoot(root, async (selected) => {
      await fs.promises.rename(root, retained)
      await fs.promises.mkdir(root)
      await fs.promises.writeFile(path.join(root, "settings"), "replacement")
      await FileAtomicWrite.write(selected, ["config", "settings"], Buffer.from("original"))
      expect(await fs.promises.readFile(path.join(root, "settings"), "utf8")).toBe("replacement")
      expect(await fs.promises.readdir(root)).toEqual(["settings"])
      expect(await fs.promises.readFile(path.join(retained, "config", "settings"), "utf8")).toBe("original")
      expect((await fs.promises.stat(path.join(retained, "config", "settings"))).mode & 0o777).toBe(0o600)
      await FileAtomicWrite.write(selected, ["config", "settings"], Buffer.from("updated"))
      expect(await fs.promises.readFile(path.join(retained, "config", "settings"), "utf8")).toBe("updated")
    })
  },
)

test.skipIf(!supported)(
  "a failed anchored replacement preserves the old destination and removes only its own temporary file",
  async () => {
    await using temporary = await tmpdir()
    await fs.promises.mkdir(path.join(temporary.path, "settings"))
    await fs.promises.writeFile(path.join(temporary.path, "settings", "original"), "retained")
    await expect(
      FileAtomicWrite.withRoot(temporary.path, (selected) =>
        FileAtomicWrite.write(selected, ["settings"], Buffer.from("new")),
      ),
    ).rejects.toThrow()
    expect(await fs.promises.readFile(path.join(temporary.path, "settings", "original"), "utf8")).toBe("retained")
    expect((await fs.promises.readdir(temporary.path)).filter((name) => name !== ".synergy")).toEqual(["settings"])
  },
)

test.skipIf(!supported)(
  "anchored publication refuses symlink traversal and a token escaping its callback",
  async () => {
    await using temporary = await tmpdir()
    const root = path.join(temporary.path, "root")
    const outside = path.join(temporary.path, "outside")
    await fs.promises.mkdir(root)
    await fs.promises.mkdir(outside)
    await fs.promises.symlink(outside, path.join(root, "link"))
    await expect(
      FileAtomicWrite.withRoot(root, (selected) =>
        FileAtomicWrite.write(selected, ["link", "settings"], Buffer.from("unwanted")),
      ),
    ).rejects.toThrow()
    expect(await fs.promises.readdir(outside)).toEqual([])
    const escaped = await FileAtomicWrite.withRoot(root, async (selected) => selected)
    expect(() => FileAtomicWrite.write(escaped, ["settings"], Buffer.from("unwanted"))).toThrow("open callback")
    expect(await fs.promises.readdir(root)).toEqual(["link"])
  },
)

test.skipIf(!supported)(
  "the original directory descriptor survives accepted work after the outer callback returns",
  async () => {
    await using temporary = await tmpdir()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const sync = fs.fsync
    let held = false
    using _checkpoint = spyOn(fs, "fsync").mockImplementation(
      Object.assign(
        (fd: number, callback: Parameters<typeof fs.fsync>[1]) => {
          if (!held) {
            held = true
            entered.resolve()
            void release.promise.then(() => sync(fd, callback))
          } else sync(fd, callback)
        },
        { __promisify__: sync.__promisify__ },
      ),
    )
    let closed = false
    const work = FileAtomicWrite.withRoot(temporary.path, async (selected) => {
      void FileAtomicWrite.write(selected, ["settings"], Buffer.from("accepted"))
    }).then(() => {
      closed = true
    })
    try {
      await entered.promise
      await Promise.resolve()
      expect(closed).toBe(false)
      release.resolve()
      await work
      expect(await fs.promises.readFile(path.join(temporary.path, "settings"), "utf8")).toBe("accepted")
    } finally {
      release.resolve()
      await work
    }
  },
)

test.skipIf(supported)("unsupported native targets refuse publication before effects", () => {
  expect(() => FileAtomicWrite.assertSupported()).toThrow("unavailable")
})

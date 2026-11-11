import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { SessionTransferStream as Stream } from "@ericsanchezok/synergy-harness/session/transfer"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { NativeWorkspacePortableTree as Portable } from "../../src/workspace/portable-tree"

test("paged native Workspace files restore after the source disappears without retaining a whole tree or file", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await fs.mkdir(path.join(source, "nested", "empty"), { recursive: true })
    const bytes = Buffer.alloc(Stream.chunkBytes + 37, 0x8f)
    await Bun.write(path.join(source, "nested", "binary"), bytes)
    await fs.chmod(path.join(source, "nested", "binary"), 0o755)
    await Bun.write(path.join(source, ".ignored"), "actual ignored file")
    if (process.platform !== "win32") await fs.symlink("nested/binary", path.join(source, "link"))
    const objects = new Map<string, Uint8Array>()
    let maximum = 0
    const store: BlobStore = {
      async put(hash, value) {
        maximum = Math.max(maximum, value.byteLength)
        objects.set(hash, value.slice())
      },
      async get(hash, limit) {
        const value = objects.get(hash)
        if (!value || value.byteLength > limit) throw new Error("Missing bounded object")
        return value.slice()
      },
    }
    const captured = await Portable.capture({ root: source, directory: path.join(tmp.path, "capture"), store })
    expect(captured.tree.entries).toBe(process.platform === "win32" ? 4 : 5)
    expect(maximum).toBeLessThanOrEqual(Stream.chunkBytes)
    await fs.rm(source, { recursive: true })
    const destination = path.join(tmp.path, "destination")
    await Portable.materialize({ root: destination, directory: path.join(tmp.path, "reader"), captured, store })
    expect(await Bun.file(path.join(destination, "nested", "binary")).bytes()).toEqual(new Uint8Array(bytes))
    expect(await Bun.file(path.join(destination, ".ignored")).text()).toBe("actual ignored file")
    expect((await fs.stat(path.join(destination, "nested", "empty"))).isDirectory()).toBe(true)
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(destination, "nested", "binary"))).mode & 0o777).toBe(0o755)
      expect(await fs.readlink(path.join(destination, "link"))).toBe("nested/binary")
    }
    await expect(
      Portable.materialize({ root: destination, directory: path.join(tmp.path, "second"), captured, store }),
    ).rejects.toThrow("empty")
  })
})

test("portable capture rejects a changed source and escaping links before returning a complete root", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "file"), "first bytes")
    const store: BlobStore = {
      async put() {
        await Bun.write(path.join(source, "file"), "external changed bytes")
      },
      async get() {
        throw new Error("Capture never reads object content")
      },
    }
    await expect(Portable.capture({ root: source, directory: path.join(tmp.path, "changed"), store })).rejects.toThrow(
      "changed",
    )
    if (process.platform === "win32") return
    await fs.symlink("../outside", path.join(source, "link"))
    await expect(Portable.capture({ root: source, directory: path.join(tmp.path, "link"), store })).rejects.toThrow(
      "escapes",
    )
  })
})

test("native capture rejects a cache within its source before creating any source files", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await fs.mkdir(source)
    const before = await fs.stat(source, { bigint: true })
    const store: BlobStore = {
      async put() {},
      async get() {
        throw new Error("unused")
      },
    }
    await expect(Portable.capture({ root: source, directory: path.join(source, "cache"), store })).rejects.toThrow(
      "overlap",
    )
    expect(await fs.readdir(source)).toEqual([])
    const after = await fs.stat(source, { bigint: true })
    expect([after.mtimeNs, after.ctimeNs]).toEqual([before.mtimeNs, before.ctimeNs])
  })
})

test.skipIf(process.platform === "win32")(
  "a replaced parent directory cannot export outside bytes before the change is rejected",
  async () => {
    await using runtime = await testRuntime()
    await using tmp = await tmpdir()
    await runtime.run(async () => {
      const source = path.join(tmp.path, "source")
      const nested = path.join(source, "nested")
      const outside = path.join(tmp.path, "outside")
      await fs.mkdir(nested, { recursive: true })
      await fs.mkdir(outside)
      await Bun.write(path.join(outside, "unrelated"), "outside bytes must never be exported")
      let puts = 0
      const opendir = fs.opendir
      using replaced = spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
        if (args[0] === nested) {
          await fs.rename(nested, path.join(tmp.path, "original"))
          await fs.symlink(outside, nested)
        }
        return opendir(...args)
      })
      const store: BlobStore = {
        async put() {
          puts++
        },
        async get() {
          throw new Error("unused")
        },
      }
      await expect(Portable.capture({ root: source, directory: path.join(tmp.path, "cache"), store })).rejects.toThrow(
        "changed",
      )
      expect(puts).toBe(0)
    })
  },
)

test("paged native restoration rejects corrupt bytes and cancellation without publishing a partial destination", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "binary"), Buffer.alloc(Stream.chunkBytes + 17, 0x72))
    const objects = new Map<string, Uint8Array>()
    const store: BlobStore = {
      async put(hash, value) {
        objects.set(hash, value.slice())
      },
      async get(hash, limit) {
        const value = objects.get(hash)
        if (!value || value.byteLength > limit) throw new Error("Missing bounded object")
        return value.slice()
      },
    }
    const captured = await Portable.capture({ root: source, directory: path.join(tmp.path, "capture"), store })
    const destination = path.join(tmp.path, "destination")
    await fs.mkdir(destination)
    const corrupt: BlobStore = {
      ...store,
      async get(hash, limit) {
        const bytes = await store.get(hash, limit)
        if (bytes.length === Stream.chunkBytes) bytes[0] ^= 1
        return bytes
      },
    }
    await expect(
      Portable.materialize({ root: destination, directory: path.join(tmp.path, "bad"), captured, store: corrupt }),
    ).rejects.toThrow()
    expect(await fs.readdir(destination)).toEqual([])
    const controller = new AbortController()
    const reason = new Error("Original native owner cancelled")
    const cancelled: BlobStore = {
      ...store,
      async get(hash, limit) {
        const bytes = await store.get(hash, limit)
        if (bytes.length === Stream.chunkBytes) controller.abort(reason)
        return bytes
      },
    }
    await expect(
      Portable.materialize({
        root: destination,
        directory: path.join(tmp.path, "cancelled"),
        captured,
        store: cancelled,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason)
    expect(await fs.readdir(destination)).toEqual([])
    expect((await fs.readdir(tmp.path)).some((name) => name.startsWith(".synergy-workspace-"))).toBe(false)
  })
})

test("native file inventory and restoration span multiple manifest pages with exact names and empty files", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await fs.mkdir(source)
    for (let index = 0; index < 600; index++)
      await Bun.write(path.join(source, `文件-${index}.txt`), index === 599 ? "last native bytes" : "")
    const objects = new Map<string, Uint8Array>()
    const store: BlobStore = {
      async put(hash, value) {
        objects.set(hash, value.slice())
      },
      async get(hash, limit) {
        const value = objects.get(hash)
        if (!value || value.byteLength > limit) throw new Error("Missing bounded object")
        return value.slice()
      },
    }
    const captured = await Portable.capture({ root: source, directory: path.join(tmp.path, "capture"), store })
    expect(captured.tree.entries).toBe(600)
    expect(captured.tree.pages).toBeGreaterThan(1)
    const destination = path.join(tmp.path, "destination")
    await Portable.materialize({ root: destination, directory: path.join(tmp.path, "reader"), captured, store })
    expect((await fs.readdir(destination)).length).toBe(600)
    expect(await Bun.file(path.join(destination, "文件-0.txt")).text()).toBe("")
    expect(await Bun.file(path.join(destination, "文件-599.txt")).text()).toBe("last native bytes")
  })
})

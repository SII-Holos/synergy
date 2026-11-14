import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { Asset } from "../../src/asset/asset"
import { storedAssets } from "../../src/asset/stored-assets"
import { tmpdir } from "../support/fixture"

test("native immutable Asset installation streams complete objects and retains existing data on failures", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const block = Buffer.alloc(1024 * 1024, 23)
    const digest = createHash("sha256")
    for (let index = 0; index < 65; index++) digest.update(block)
    const sha256 = digest.digest("hex")
    const id = sha256.slice(0, 16) + ".bin"
    const bytes = 65 * block.length
    const content = () =>
      (async function* () {
        for (let index = 0; index < 65; index++) yield block
      })()
    expect(await Asset.installStream({ id, bytes, sha256, content: content() })).toMatchObject({
      created: true,
      id,
      bytes,
      sha256,
    })
    const opened = await Asset.open(id)
    expect(opened).toMatchObject({ bytes, sha256 })
    let total = 0
    const actual = createHash("sha256")
    for await (const chunk of opened!.stream()) {
      expect(chunk.length).toBeLessThanOrEqual(4 * 1024 * 1024)
      actual.update(chunk)
      total += chunk.length
    }
    expect(total).toBe(bytes)
    expect(actual.digest("hex")).toBe(sha256)
    expect((await Asset.read(id))!.size).toBe(bytes)
    expect(await Asset.installStream({ id, bytes, sha256, content: content() })).toMatchObject({ created: false })
    const other = Buffer.from("new immutable asset")
    const otherHash = createHash("sha256").update(other).digest("hex")
    const otherID = otherHash.slice(0, 16) + ".bin"
    await expect(
      Asset.installStream({
        id: otherID,
        bytes: other.length + 1,
        sha256: otherHash,
        content: (async function* () {
          yield other
        })(),
      }),
    ).rejects.toThrow("byte count")
    expect(await Asset.read(otherID)).toBeUndefined()
    await fs.writeFile(Asset.filePath(otherID), "preexisting collision")
    await expect(
      Asset.installStream({
        id: otherID,
        bytes: other.length,
        sha256: otherHash,
        content: (async function* () {
          yield other
        })(),
      }),
    ).rejects.toThrow()
    expect(await fs.readFile(Asset.filePath(otherID), "utf8")).toBe("preexisting collision")
  })
}, 15000)

test("native Asset streams reject symlinks and changed originals instead of following arbitrary paths", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const bytes = Buffer.from("canonical immutable asset")
    const id = await Asset.write(bytes, "text/plain")
    const original = await Asset.open(id)
    await fs.writeFile(Asset.filePath(id), "changed immutable asset")
    await expect(
      (async () => {
        for await (const _chunk of original!.stream()) {
        }
      })(),
    ).rejects.toThrow()
    await fs.rm(Asset.filePath(id))
    const outside = path.join(runtime.host.home, "private-fixture")
    await fs.writeFile(outside, bytes)
    await fs.symlink(outside, Asset.filePath(id))
    await expect(Asset.open(id)).rejects.toThrow("regular")
  })
})

test("the explicitly selected stored Asset owner installs streams without changing its storage mode", async () => {
  await using home = await tmpdir()
  const bytes = Buffer.from("canonical streamed asset🌏\n".repeat(100000))
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const id = sha256.slice(0, 16) + ".txt"
  {
    const backend = storedAssets()
    using noWholeRead = spyOn(backend, "read").mockImplementation(() => {
      throw new Error("Asset materialization must stream the selected authority")
    })
    await using runtime = await testRuntime({
      home: home.path,
      register() {
        Asset.registerStorage(backend)
      },
    })
    await runtime.run(async () => {
      expect(
        await Asset.installStream({
          id,
          bytes: bytes.length,
          sha256,
          content: (async function* () {
            for (let offset = 0; offset < bytes.length; offset += 65536) yield bytes.subarray(offset, offset + 65536)
          })(),
        }),
      ).toMatchObject({ created: true })
      expect(await fs.exists(Asset.filePath(id))).toBe(false)
      const opened = await Asset.open(id)
      let size = 0
      const hash = createHash("sha256")
      for await (const block of opened!.stream()) {
        hash.update(block)
        size += block.length
      }
      expect({ size, sha256: hash.digest("hex") }).toEqual({ size: bytes.length, sha256 })
      expect((await Asset.read(id))!.size).toBe(bytes.length)
      await fs.writeFile(Asset.filePath(id), "corrupt reconstructible cache")
      expect(await (await Asset.read(id))!.bytes()).toEqual(new Uint8Array(bytes))
      await fs.rm(Asset.filePath(id))
    })
  }
  await using reopened = await testRuntime({
    home: home.path,
    register() {
      Asset.registerStorage(storedAssets())
    },
  })
  await reopened.run(async () => {
    expect((await Asset.open(id))!.sha256).toBe(sha256)
    expect((await Asset.read(id))!.size).toBe(bytes.length)
  })
})

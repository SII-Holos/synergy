import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { HomeOwnershipFile } from "../../src/lifecycle/home-ownership-file"
import { runtimeHome } from "../support/runtime-home"

const base = HomeOwnershipFile.FencedInfo.parse({
  schemaVersion: 2,
  owner: "reader-fixture",
  identity: "a".repeat(64),
  readerContract: "fixture-base-v1",
})
const next = HomeOwnershipFile.FencedInfo.parse({ ...base, readerContract: "fixture-next-v1" })

test("reader advancement changes only the selected contract under an exact current marker", async () => {
  await using f = await runtimeHome()
  const previous = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: base })
  const target = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: next })
  await previous.persist()
  const original = await previous.read()
  await expect(target.advanceReader({ ...base, readerContract: "another-reader-v1" })).rejects.toThrow()
  expect(await previous.assert({ required: true })).toEqual(original)
  await target.advanceReader(base)
  expect(await target.assert({ required: true })).toEqual(next)
  await expect(previous.assert({ required: true })).rejects.toThrow("explicit migration")
  await expect(target.advanceReader(base)).rejects.toThrow()
  expect(await target.read()).toEqual(next)
  await target.advanceReader(next)
  expect(await target.read()).toEqual(next)
})

test("reader advancement cannot replace a legacy or permanently retired Home", async () => {
  await using legacy = await runtimeHome()
  const originalLegacy = HomeOwnershipFile.LegacyInfo.parse({
    schemaVersion: 1,
    owner: base.owner,
    identity: base.identity,
  })
  const legacyOwner = HomeOwnershipFile.open({ root: legacy.host.root, env: legacy.host.env, selected: originalLegacy })
  await legacyOwner.persist()
  const legacyTarget = HomeOwnershipFile.open({ root: legacy.host.root, env: legacy.host.env, selected: next })
  await expect(legacyTarget.advanceReader(originalLegacy)).rejects.toThrow()
  expect(await legacyOwner.assert({ required: true })).toEqual(originalLegacy)

  await using retired = await runtimeHome()
  const source = HomeOwnershipFile.open({ root: retired.host.root, env: retired.host.env, selected: base })
  await source.persist()
  const marker = HomeOwnershipFile.RetirementInfo.parse({
    ...base,
    schemaVersion: 4,
    readerContract: "fixture-retired-v1",
    maintenanceID: "retired-source",
    referenceHash: "b".repeat(64),
    physicalHash: await source.physicalHash(),
    source: base,
  })
  const retirement = HomeOwnershipFile.open({ root: retired.host.root, env: retired.host.env, selected: marker })
  await retirement.retire(base)
  const retiredTarget = HomeOwnershipFile.open({ root: retired.host.root, env: retired.host.env, selected: next })
  await expect(retiredTarget.advanceReader(marker)).rejects.toThrow()
  expect(await retirement.assert({ required: true })).toEqual(marker)
})

for (const replacement of ["root", "marker"] as const)
  test(`reader advancement preserves a substituted ${replacement} after validating its original marker`, async () => {
    await using f = await runtimeHome()
    const filename = path.join(f.host.root, "home-ownership.json")
    const previous = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: base })
    const target = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: next })
    await previous.persist()
    const original = await fs.stat(filename)
    const foreign = JSON.stringify({ ...base, owner: "foreign-reader", identity: "f".repeat(64) }) + "\n"
    const open = fs.open
    let replaced = false
    using barrier = spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args)
      if (args[0] === filename && typeof args[1] === "number") {
        const write = file.write.bind(file)
        spyOn(file, "write").mockImplementation(
          new Proxy(write, {
            async apply(method, receiver, args) {
              if (!replaced) {
                replaced = true
                if (replacement === "root") {
                  await fs.rename(f.host.root, f.host.root + "-original")
                  await fs.mkdir(f.host.root)
                } else await fs.rename(filename, filename + ".original")
                await fs.writeFile(filename, foreign)
              }
              return Reflect.apply(method, receiver, args)
            },
          }),
        )
      }
      return file
    })
    const outcome = await target.advanceReader(base).then(
      () => "accepted",
      () => "rejected",
    )
    barrier.mockRestore()
    expect(replaced).toBe(true)
    const detached =
      replacement === "root" ? path.join(f.host.root + "-original", "home-ownership.json") : filename + ".original"
    expect((await fs.stat(detached)).ino).toBe(original.ino)
    expect(await fs.readFile(filename, "utf8")).toBe(foreign)
    expect(outcome).toBe("rejected")
  })

test("a lost reader publication acknowledgement reconciles only the complete actual target", async () => {
  await using f = await runtimeHome()
  const filename = path.join(f.host.root, "home-ownership.json")
  const previous = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: base })
  const target = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: next })
  await previous.persist()
  const open = fs.open
  const lost = new Error("Reader publication was synced before its acknowledgement was lost")
  let synced = false
  using barrier = spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args)
    if (args[0] === filename && typeof args[1] === "number") {
      const sync = file.sync.bind(file)
      spyOn(file, "sync").mockImplementation(async () => {
        await sync()
        synced = true
        throw lost
      })
    }
    return file
  })
  await expect(target.advanceReader(base)).rejects.toBe(lost)
  barrier.mockRestore()
  expect(synced).toBe(true)
  expect(await target.assert({ required: true })).toEqual(next)
  await expect(previous.assert({ required: true })).rejects.toThrow()
  await expect(target.advanceReader(base)).rejects.toThrow()
  await target.advanceReader(next)
  expect(await target.assert({ required: true })).toEqual(next)
})

test("an interrupted reader write cannot repair a partial or empty marker from its expected DTO", async () => {
  const selected = HomeOwnershipFile.FencedInfo.parse({
    ...next,
    readerContract: "fixture-next-reader-with-longer-contract-v1",
  })
  for (const interrupted of ["partial", "empty"] as const) {
    await using f = await runtimeHome()
    const filename = path.join(f.host.root, "home-ownership.json")
    const previous = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected: base })
    const target = HomeOwnershipFile.open({ root: f.host.root, env: f.host.env, selected })
    await previous.persist()
    const open = fs.open
    const lost = new Error(`Reader native ${interrupted} write was interrupted`)
    let written = false
    using barrier = spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args)
      if (args[0] === filename && typeof args[1] === "number") {
        const write = file.write.bind(file)
        spyOn(file, "write").mockImplementation(async () => {
          if (interrupted === "empty") await file.truncate(0)
          else {
            const encoded = Buffer.from(JSON.stringify(selected) + "\n")
            await write(encoded, 0, encoded.byteLength - 2, 0)
          }
          written = true
          throw lost
        })
      }
      return file
    })
    await expect(target.advanceReader(base)).rejects.toBe(lost)
    barrier.mockRestore()
    expect(written).toBe(true)
    const retained = await fs.readFile(filename)
    expect(retained.byteLength).toBe(interrupted === "empty" ? 0 : Buffer.byteLength(JSON.stringify(selected)) - 1)
    await expect(target.read()).rejects.toThrow("invalid or unsupported")
    await expect(target.advanceReader(base)).rejects.toThrow("invalid or unsupported")
    expect(await fs.readFile(filename)).toEqual(retained)
  }
})

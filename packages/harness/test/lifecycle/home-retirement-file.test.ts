import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { HomeOwnershipFile } from "../../src/lifecycle/home-ownership-file"
import { runtimeHome } from "../support/runtime-home"

test("permanent source retirement excludes literal released readers and retains the first native publication", async () => {
  await using fixture = await runtimeHome()
  const original = {
    schemaVersion: 2 as const,
    owner: "organization",
    identity: "a".repeat(64),
    readerContract: "native-organization-service-ownership-v1",
  }
  const files = HomeOwnershipFile.open({ root: fixture.host.root, env: fixture.host.env, selected: original })
  await files.persist()
  const retired = {
    ...original,
    schemaVersion: 4 as const,
    readerContract: "native-organization-service-retirement-v1",
    maintenanceID: "frozen-source",
    referenceHash: "b".repeat(64),
    physicalHash: await files.physicalHash(),
    source: original,
  }
  await fs.mkdir(path.join(fixture.host.root, "auth"))
  await fs.writeFile(path.join(fixture.host.root, "auth", "organization-runtime.json"), "private fixture credential")
  const compiled = await Bun.build({
    entrypoints: [new URL("./support/ownership-v2-reader.ts", import.meta.url).pathname],
    target: "node",
  })
  if (!compiled.success) throw new Error("Literal released reader did not compile")
  const entry = path.join(fixture.host.home, "released-reader.mjs")
  await fs.writeFile(entry, await compiled.outputs[0]!.text())
  async function reader(operation: "credentials" | "sql", name: string) {
    const probe = path.join(fixture.host.home, name)
    const child = Bun.spawn(
      [
        operation === "credentials" ? "node" : process.execPath,
        entry,
        fixture.host.root,
        operation,
        probe,
        pathToFileURL(new URL("../../src/storage/transactional-store.ts", import.meta.url).pathname).href,
      ],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    )
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, reached: await Bun.file(probe).exists() }
  }
  expect(await reader("credentials", "before-credentials")).toEqual({ code: 0, reached: true })
  expect(await reader("sql", "before-sql")).toEqual({ code: 0, reached: true })
  const target = HomeOwnershipFile.open({ root: fixture.host.root, env: fixture.host.env, selected: retired })
  const open = fs.open
  const lost = new Error("native source retirement acknowledgement lost")
  const barrier = spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args)
    if (args[0] === path.join(fixture.host.root, "home-ownership.json") && args[1] !== "r") {
      const sync = file.sync.bind(file)
      let calls = 0
      spyOn(file, "sync").mockImplementation(async () => {
        await sync()
        if (++calls === 2) throw lost
      })
    }
    return file
  })
  try {
    await expect(target.retire(original)).rejects.toBe(lost)
  } finally {
    barrier.mockRestore()
  }
  expect(await target.assert({ required: true })).toEqual(retired)
  await target.retire(original)
  await expect(files.assert({ required: true })).rejects.toThrow()
  expect(await reader("credentials", "after-credentials")).toEqual({ code: 1, reached: false })
  expect(await reader("sql", "after-sql")).toEqual({ code: 1, reached: false })
  await expect(
    HomeOwnershipFile.open({
      root: fixture.host.root,
      env: fixture.host.env,
      selected: { ...retired, referenceHash: "c".repeat(64) },
    }).retire(original),
  ).rejects.toThrow("changed")
  await using copy = await runtimeHome()
  await fs.copyFile(
    path.join(fixture.host.root, "home-ownership.json"),
    path.join(copy.host.root, "home-ownership.json"),
  )
  await expect(
    HomeOwnershipFile.open({ root: copy.host.root, env: copy.host.env, selected: retired }).assert({ required: true }),
  ).rejects.toThrow("physical identity")
})

async function retirementFixture() {
  const fixture = await runtimeHome()
  const original = {
    schemaVersion: 2 as const,
    owner: "organization",
    identity: "a".repeat(64),
    readerContract: "native-organization-service-ownership-v1",
  }
  const files = HomeOwnershipFile.open({ root: fixture.host.root, env: fixture.host.env, selected: original })
  await files.persist()
  const marker = HomeOwnershipFile.RetirementInfo.parse({
    ...original,
    schemaVersion: 4,
    readerContract: "native-organization-service-retirement-v1",
    maintenanceID: "original-frozen-source",
    referenceHash: "b".repeat(64),
    physicalHash: await files.physicalHash(),
    source: original,
  })
  const target = HomeOwnershipFile.open({ root: fixture.host.root, env: fixture.host.env, selected: marker })
  return { ...fixture, original, files, marker, target, filename: path.join(fixture.host.root, "home-ownership.json") }
}

for (const replacement of ["directory", "file"] as const)
  test(`permanent publication never writes into a substituted native ${replacement}`, async () => {
    await using fixture = await retirementFixture()
    const open = fs.open
    let replaced = false
    using barrier = spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await open(...args)
      if (args[0] === fixture.filename && typeof args[1] === "number") {
        const write = file.write.bind(file)
        spyOn(file, "write").mockImplementation((async (
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          if (!replaced) {
            replaced = true
            if (replacement === "directory") {
              await fs.rename(fixture.host.root, fixture.host.root + "-original")
              await fs.mkdir(fixture.host.root, { recursive: true })
            } else await fs.rename(fixture.filename, fixture.filename + ".original")
            await fs.writeFile(fixture.filename, JSON.stringify(fixture.original))
          }
          return write(buffer, offset, length, position)
        }) as typeof file.write)
      }
      return file
    })
    await expect(fixture.target.retire(fixture.original)).rejects.toThrow()
    expect(replaced).toBe(true)
    expect(await fixture.files.read()).toEqual(fixture.original)
    const detached =
      replacement === "directory"
        ? path.join(fixture.host.root + "-original", "home-ownership.json")
        : fixture.filename + ".original"
    expect(JSON.parse(await fs.readFile(detached, "utf8"))).toEqual(fixture.marker)
  })

test("an interrupted retirement is strict for startup and can repair only its exact retained prefix", async () => {
  await using fixture = await retirementFixture()
  const encoded = JSON.stringify(fixture.marker) + "\n"
  for (const size of [0, 1, 19, encoded.length - 2]) {
    await fs.writeFile(fixture.filename, encoded.slice(0, size))
    await expect(fixture.files.read()).rejects.toThrow("invalid or unsupported")
    expect(await fixture.target.inspectRetirement(fixture.original)).toBe("incomplete")
    await fixture.target.retire(fixture.original)
    expect(await fixture.target.assert({ required: true })).toEqual(fixture.marker)
  }
  await fs.writeFile(fixture.filename, '{"schemaVersion":4,"foreign":true}')
  await expect(fixture.target.inspectRetirement(fixture.original)).rejects.toThrow("changed")
  await expect(fixture.target.retire(fixture.original)).rejects.toThrow("changed")
  expect(await fs.readFile(fixture.filename, "utf8")).toBe('{"schemaVersion":4,"foreign":true}')
})

test("an actual interrupted fd write leaves a repairable prefix without reopening the old reader", async () => {
  await using fixture = await retirementFixture()
  const open = fs.open
  const lost = new Error("native interrupted write")
  using barrier = spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args)
    if (args[0] === fixture.filename && typeof args[1] === "number") {
      const write = file.write.bind(file)
      spyOn(file, "write").mockImplementation(async (buffer: NodeJS.ArrayBufferView | string) => {
        if (!(buffer instanceof Uint8Array)) throw new Error("Expected native byte publication")
        await write(buffer, 0, 23, 0)
        throw lost
      })
    }
    return file
  })
  await expect(fixture.target.retire(fixture.original)).rejects.toBe(lost)
  await expect(fixture.files.assert({ required: true })).rejects.toThrow("invalid or unsupported")
  expect(await fixture.target.inspectRetirement(fixture.original)).toBe("incomplete")
  barrier.mockRestore()
  await fixture.target.retire(fixture.original)
  expect(await fixture.target.assert({ required: true })).toEqual(fixture.marker)
})

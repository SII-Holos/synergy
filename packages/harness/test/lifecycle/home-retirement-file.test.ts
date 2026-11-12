import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
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
  const write = AtomicFile.writeJsonAtomic
  const lost = new Error("native source retirement acknowledgement lost")
  const barrier = spyOn(AtomicFile, "writeJsonAtomic").mockImplementation(async (...args) => {
    await write(...args)
    if (args[0] === path.join(fixture.host.root, "home-ownership.json")) throw lost
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

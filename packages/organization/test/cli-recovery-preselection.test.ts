import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationSourceRetirement as Retirement } from "../src/backup/source-retirement"
import { openOrganizationRecovery, openOrganizationService, openOrganizationSourceRetirement } from "../src/service"
import { preparedFixture } from "./support/recovery-administration"

const Barrier = z.strictObject({
  state: z.literal("source-preselection-frozen"),
  operation: z.strictObject({
    maintenanceID: z.string(),
    requestID: z.string(),
    requestHash: z.string(),
    sourceRuntimeID: z.string(),
    cohortHash: z.string(),
    phase: z.literal("frozen"),
    actor: ActorStamp.Info,
  }),
})

async function bounded<T>(work: Promise<T>, label: string) {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error(label)), 5000)
  try {
    return await Promise.race([work, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

const owner = (home: string) => HomeOwnershipFile.open({ root: path.join(home, ".synergy"), env: process.env }).read()

test("public recover resumes the same Source operation after SIGKILL before H1 capture or Reference", async () => {
  await using f = await preparedFixture()
  const sourceOwner = await owner(f.input.sourceHome)
  const targetOwner = await owner(f.input.home)
  expect(sourceOwner).toMatchObject({ schemaVersion: 2, owner: "organization" })
  expect(targetOwner).toMatchObject({
    schemaVersion: 3,
    owner: "organization",
    installationID: f.target.installationID,
    incarnation: f.target.incarnation,
  })
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-bunfig",
      path.join(import.meta.dir, "fixtures/source-preselection-crash.mjs"),
      "recover",
      "--input",
      f.input.directory,
      "--restore-id",
      f.input.restoreID,
      "--source-home",
      f.input.sourceHome,
      "--work",
      f.input.work,
      "--key-file",
      path.join(f.root, "key.json"),
      "--origin",
      f.input.publicOrigin,
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        SYNERGY_HOME: f.input.home,
        SYNERGY_RUNTIME_ROOT: undefined,
        NODE_PATH: undefined,
        NODE_OPTIONS: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  let barrier: z.infer<typeof Barrier>
  try {
    barrier = await bounded(
      (async () => {
        let output = ""
        for (;;) {
          const next = await reader.read()
          if (next.done) throw new Error("The Source child exited before its actual frozen operation was observed")
          output += new TextDecoder().decode(next.value)
          if (output.length > 8192) throw new Error("The Source child exceeded its metadata-only barrier output")
          const end = output.indexOf("\n")
          if (end < 0) continue
          return Barrier.parse(JSON.parse(output.slice(0, end)))
        }
      })(),
      "The actual Source did not reach the frozen preselection barrier",
    )
    expect(barrier.operation.actor).toMatchObject({ kind: "system", requestID: barrier.operation.requestID })
    child.kill("SIGKILL")
    expect(await bounded(child.exited, "The task-owned Source child did not exit after SIGKILL")).not.toBe(0)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    reader.releaseLock()
    await stderr
  }
  expect(await owner(f.input.sourceHome)).toEqual(sourceOwner)
  expect(await owner(f.input.home)).toEqual(targetOwner)
  expect(await fs.exists(f.input.work)).toBe(true)
  expect(await fs.exists(path.join(f.input.work, "reference.json"))).toBe(false)
  expect(await fs.exists(path.join(f.input.work, "h1"))).toBe(false)
  expect(await f.materialHash()).toBe(f.originalKey)
  {
    await using target = await openOrganizationRecovery({ home: f.input.home })
    expect(await target.run(() => RuntimeMaintenance.status())).toMatchObject({
      maintenanceID: f.target.installationID,
      phase: "recovery-held",
    })
    expect(Buffer.from(await target.run(() => Storage.readBinary(["organization", "retained-binary"])))).toEqual(
      Buffer.from("original retained bytes"),
    )
  }
  const recovered = await f.invoke()
  expect(recovered.code, recovered.stderr).toBe(0)
  expect(JSON.parse(recovered.stdout)).toMatchObject({
    state: "ready",
    executionEnabled: false,
    installationID: f.target.installationID,
    restoreID: f.input.restoreID,
    incarnation: f.target.incarnation,
  })
  expect(await f.materialHash()).toBe(f.originalKey)
  const selector = z
    .object({ reference: Retirement.Reference })
    .parse(JSON.parse(await fs.readFile(path.join(f.input.work, "reference.json"), "utf8")))
  expect(selector.reference.current.maintenance).toMatchObject(barrier.operation)
  expect(selector.reference.target).toMatchObject({
    installationID: f.target.installationID,
    restoreID: f.input.restoreID,
    incarnation: f.target.incarnation,
  })
  expect(await owner(f.input.sourceHome)).toMatchObject({ schemaVersion: 4, owner: "organization" })
  await using source = await openOrganizationSourceRetirement({
    home: await fs.realpath(f.input.sourceHome),
    reference: selector.reference,
  })
  expect(await source.run(() => RuntimeMaintenance.status())).toEqual(selector.reference.current.maintenance)
  expect(await source.run(() => RuntimeMaintenance.retirement(barrier.operation.maintenanceID))).toBeDefined()
  await using ordinary = await openOrganizationService({ home: f.input.home })
  expect((await ordinary.fetch(new Request(f.input.publicOrigin + "/org/v1/ready"))).status).toBe(200)
  expect(await ordinary.capabilities()).toMatchObject({ executesAgents: false })
  expect(
    Buffer.from(await ordinary.maintenance.run(() => Storage.readBinary(["organization", "retained-binary"]))),
  ).toEqual(Buffer.from("original retained bytes"))
}, 30_000)

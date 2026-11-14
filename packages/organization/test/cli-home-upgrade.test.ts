import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { openOrganizationService } from "../src/service"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { fixture } from "./support/organization"

const requestID = "upgrade-service-environment-reader"
const standalone = path.resolve(import.meta.dir, "../src/entry.ts")
const nested = path.join(import.meta.dir, "fixtures/cli.mjs")

async function invoke(env: Record<string, string | undefined>, args: string[], shared = false) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-bunfig",
      shared ? nested : standalone,
      ...(shared ? ["org"] : []),
      ...args,
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...env, SYNERGY_RUNTIME_ROOT: undefined, NODE_PATH: undefined, NODE_OPTIONS: undefined },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function configureEnvironment(home: string) {
  const filename = path.join(home, ".synergy", "config", "synergy.d", "150-organization.jsonc")
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(
    filename,
    JSON.stringify({
      organization: {
        infrastructure: {
          version: 1,
          environments: {
            execution: {
              provider: "docker",
              host: { endpoint: new URL(`unix://${path.join(home, "absent-engine.sock")}`).href },
              spec: { image: "synthetic-reader-upgrade:test" },
            },
          },
        },
      },
    }),
  )
}

test("organization Home upgrade is discoverable through both parsers without opening an Agent Home", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    for (const shared of [true, false]) {
      const result = await invoke(isolated.env, ["upgrade", "--help"], shared)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain("request-id")
      expect(result.stdout).toContain("reader")
    }
    expect(await fs.readdir(isolated.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    await isolated.dispose()
  }
})

test("organization Home upgrade rejects invalid admission without creating service or ambient data", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const args = ["upgrade", "--request-id", requestID]
    for (const [env, input] of [
      [isolated.env, args],
      [{ ...isolated.env, SYNERGY_HOME: "relative-home" }, args],
      [{ ...isolated.env, SYNERGY_HOME: isolated.env.SYNERGY_TEST_HOME }, [...args, "--unknown-option"]],
      [{ ...isolated.env, SYNERGY_HOME: isolated.env.SYNERGY_TEST_HOME }, ["upgrade"]],
    ] as const)
      expect((await invoke(env, [...input])).code).toBe(1)
    expect(await fs.readdir(isolated.env.SYNERGY_TEST_HOME!, { recursive: true })).toEqual([])
  } finally {
    await isolated.dispose()
  }
})

test("the public upgrade command advances an established Service reader and releases its exact native operation", async () => {
  await using f = await fixture()
  await f.initialize()
  const home = f.service.home
  const marker = path.join(home, ".synergy", "home-ownership.json")
  const original = HomeOwnershipFile.FencedInfo.parse(await Bun.file(marker).json())
  const signing = await f.service.maintenance.run(() => Storage.read(Keys.signingIdentity()))
  const deployment = await f.service.deployment()
  await f.service.close()
  await configureEnvironment(home)
  const env = { ...process.env, SYNERGY_HOME: home, SYNERGY_TEST_HOME: home }
  const result = await invoke(env, ["upgrade", "--request-id", requestID])
  expect(result.code, result.stderr).toBe(0)
  const receipt: unknown = JSON.parse(result.stdout)
  expect(receipt).toMatchObject({
    state: "upgrade-complete",
    restartRequired: true,
    executesAgents: false,
    schemaVersion: 2,
    readerContract: "native-organization-service-environments-v1",
  })
  expect(HomeOwnershipFile.FencedInfo.parse(await Bun.file(marker).json())).toEqual({
    ...original,
    readerContract: "native-organization-service-environments-v1",
  })
  const duplicate = await invoke(env, ["upgrade", "--request-id", requestID], true)
  expect(duplicate.code, duplicate.stderr).toBe(0)
  expect(JSON.parse(duplicate.stdout)).toEqual(receipt)
  await using reopened = await openOrganizationService({ home })
  expect(await reopened.deployment()).toEqual(deployment)
  await reopened.maintenance.run(async () => {
    expect(await Storage.read(Keys.signingIdentity())).toEqual(signing)
    const operation = await RuntimeMaintenance.status()
    expect(operation).toMatchObject({ purpose: "organization-home-upgrade", requestID, phase: "released" })
    expect(await Storage.queryKeys({ prefix: ["runtime_maintenance", "operations"], limit: 10 })).toHaveLength(1)
    await RuntimeMaintenance.assertAdmission()
  })
})

for (const phase of ["draining", "frozen", "releasing", "released"] as const)
  test(`a public cold retry retains the original upgrade after a real child exits in ${phase}`, async () => {
    await using f = await fixture()
    await f.initialize()
    const home = f.service.home
    const deployment = await f.service.deployment()
    await f.service.close()
    await configureEnvironment(home)
    const env = {
      ...process.env,
      SYNERGY_HOME: home,
      SYNERGY_TEST_HOME: home,
      SERVICE_UPGRADE_TEST_REQUEST: requestID,
      SERVICE_UPGRADE_TEST_PHASE: phase,
    }
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--no-bunfig", path.join(import.meta.dir, "fixtures/home-upgrade-crash.mjs")],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    )
    const stderr = new Response(child.stderr).text()
    let publication: {
      state: string
      phase: string
      operation: { maintenanceID: string; sourceRuntimeID: string; requestID: string; requestHash: string }
    }
    try {
      const reader = child.stdout.getReader()
      let output = ""
      while (!output.includes("\n")) {
        const next = await reader.read()
        if (next.done)
          throw new Error(`The original upgrade child stopped before durable reader publication: ${await stderr}`)
        output += new TextDecoder().decode(next.value)
      }
      reader.releaseLock()
      publication = JSON.parse(output.split("\n")[0])
      expect(publication).toMatchObject({ state: "upgrade-barrier", phase, operation: { requestID } })
      child.kill("SIGKILL")
      expect(await child.exited).not.toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await stderr
    }
    const result = await invoke(env, ["upgrade", "--request-id", requestID])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "upgrade-complete",
      maintenanceID: publication.operation.maintenanceID,
    })
    await using reopened = await openOrganizationService({ home })
    expect(await reopened.deployment()).toEqual(deployment)
    await reopened.maintenance.run(async () => {
      expect(await RuntimeMaintenance.status()).toMatchObject({ ...publication.operation, phase: "released" })
      expect(await Storage.queryKeys({ prefix: ["runtime_maintenance", "operations"], limit: 10 })).toHaveLength(1)
      await RuntimeMaintenance.assertAdmission()
    })
  }, 30_000)

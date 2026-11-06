import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { InstallationGenerations } from "../../src/installation/generations"
import { loadInstalledComponents } from "../../src/installation/component-loader"
import { verifyInstalledWorkerPlan } from "../../src/installation/bootstrap"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-component-loader-"))
  const directory = await InstallationGenerations.stage(root)
  const harness = path.join(directory, "node_modules/@ericsanchezok/synergy-harness")
  await Bun.write(
    path.join(harness, "package.json"),
    JSON.stringify({
      name: "@ericsanchezok/synergy-harness",
      version: "2.0.0",
      exports: { "./lifecycle": "./lifecycle.js" },
    }),
  )
  await Bun.write(path.join(harness, "lifecycle.js"), "export const identity = {}")
  const metadata = {
    formatVersion: 1 as const,
    kind: "component" as const,
    apiVersion: 1 as const,
    id: "example",
    version: "2.0.0",
    compatibility: { synergy: "^2.0.0" },
    entry: "./component.js",
    export: "example",
    requires: { "local-runtime": "2.0.0" },
  }
  const entry = path.join(directory, "node_modules/example/component.js")
  await Bun.write(
    entry,
    `export function example() { return { id: "example", version: "2.0.0", apiVersion: 1, requires: { "local-runtime": "2.0.0" }, register() {} } }`,
  )
  return {
    root,
    directory,
    entry,
    input: {
      directory,
      hostVersion: "2.0.0",
      roots: { example: "2.0.0" },
      packages: { example: { directory: "node_modules/example", version: "2.0.0", spec: "2.0.0", metadata } },
      trustHostCode: true,
    },
    [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }),
  }
}

test("loads only the requested installed selection and pins old generations for workers", async () => {
  await using temp = await fixture()
  const first = await InstallationGenerations.commit(temp.root, temp.input)
  expect((await loadInstalledComponents(first)).components.map((item) => item.id)).toEqual(["example"])
  expect((await loadInstalledComponents(first, {})).components).toEqual([])
  await expect(loadInstalledComponents(first, { missing: "2.0.0" })).rejects.toThrow("not installed")
  const directory = await InstallationGenerations.stage(temp.root)
  await InstallationGenerations.commit(temp.root, {
    ...temp.input,
    directory,
    previous: first.id,
    roots: {},
    packages: {},
  })
  const pinned = await InstallationGenerations.pin(temp.root, { id: first.id, sha256: first.sha256 })
  expect(pinned.id).toBe(first.id)
  expect((await loadInstalledComponents(pinned)).components.map((item) => item.id)).toEqual(["example"])
})

test("installed and source selection agree and a disabled experiment never evaluates its module", async () => {
  await using temp = await fixture()
  const features = {
    kind: "product" as const,
    definitions: [
      {
        id: "example",
        owner: "example",
        maturity: "experimental" as const,
        activation: "restart" as const,
        component: "example",
        name: "Example",
        description: "Fixture experiment",
      },
    ],
  }
  const marker = path.join(temp.root, "evaluated")
  const metadata = { ...temp.input.packages.example.metadata, features, maintenance: "./maintenance.js" }
  await Bun.write(path.join(path.dirname(temp.entry), "maintenance.js"), "export function registerMaintenance() {}")
  await Bun.write(
    temp.entry,
    `await Bun.write(${JSON.stringify(marker)}, "active"); export function example() { return ${JSON.stringify({ id: metadata.id, version: metadata.version, apiVersion: 1, requires: metadata.requires, features }).replace(/}$/, ', maintenance: new URL("./maintenance.js", import.meta.url), register() {} }')} }`,
  )
  const generation = await InstallationGenerations.commit(temp.root, {
    ...temp.input,
    packages: { example: { ...temp.input.packages.example, metadata } },
  })
  const disabled = await loadInstalledComponents(generation)
  expect(disabled.components).toEqual([])
  expect(disabled.features.definitions).toEqual(features.definitions)
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(disabled.maintenance.map((entry) => entry.href)).toEqual([
    pathToFileURL(path.join(generation.directory, "node_modules/example/maintenance.js")).href,
  ])
  const enabled = await loadInstalledComponents(generation, undefined, { optIn: ["example"] })
  const source = FeatureSelection.resolve([metadata], { provided: { "local-runtime": "2.0.0" }, optIn: ["example"] })
  expect(enabled.features).toEqual(source)
  expect(enabled.maintenance).toEqual([])
  expect(await Bun.file(marker).text()).toBe("active")
})

test("rejects a second Harness copy before evaluating component code", async () => {
  await using temp = await fixture()
  const marker = path.join(temp.root, "evaluated")
  await Bun.write(temp.entry, `await Bun.write(${JSON.stringify(marker)}, "bad"); export const example = () => ({})`)
  const nested = path.join(temp.directory, "node_modules/example/node_modules/@ericsanchezok/synergy-harness")
  await Bun.write(path.join(nested, "package.json"), JSON.stringify({ exports: { "./lifecycle": "./different.js" } }))
  await Bun.write(path.join(nested, "different.js"), "export const identity = {}")
  const generation = await InstallationGenerations.commit(temp.root, temp.input)
  await expect(loadInstalledComponents(generation)).rejects.toThrow("Harness identity")
  expect(await Bun.file(marker).exists()).toBe(false)
})

test("refuses factories whose executable declarations differ from the approved package", async () => {
  await using temp = await fixture()
  await Bun.write(
    temp.entry,
    `export const example = () => ({ id: "different", version: "2.0.0", apiVersion: 1, register() {} })`,
  )
  const generation = await InstallationGenerations.commit(temp.root, temp.input)
  await expect(loadInstalledComponents(generation)).rejects.toThrow("metadata")
})

test("maintenance contributions must match approved package metadata", async () => {
  await using temp = await fixture()
  for (const filename of ["maintenance.js", "unapproved.js"])
    await Bun.write(path.join(path.dirname(temp.entry), filename), "export function registerMaintenance() {}")
  await Bun.write(
    temp.entry,
    `export const example = () => ({ id: "example", version: "2.0.0", apiVersion: 1, requires: { "local-runtime": "2.0.0" }, maintenance: new URL("./unapproved.js", import.meta.url), register() {} })`,
  )
  const generation = await InstallationGenerations.commit(temp.root, {
    ...temp.input,
    packages: {
      example: {
        ...temp.input.packages.example,
        metadata: { ...temp.input.packages.example.metadata, maintenance: "./maintenance.js" },
      },
    },
  })
  await expect(loadInstalledComponents(generation)).rejects.toThrow("metadata")
})

test("home directory aliases preserve sealed component and worker identities", async () => {
  await using temp = await fixture()
  await Bun.write(
    temp.entry,
    `export function example() { return { id: "example", version: "2.0.0", apiVersion: 1, requires: { "local-runtime": "2.0.0" }, workers: { agent: new URL("./worker.js", import.meta.url) }, register() {} } }`,
  )
  await Bun.write(path.join(path.dirname(temp.entry), "worker.js"), "export const role = 'agent'")
  await InstallationGenerations.commit(temp.root, temp.input)
  const alias = path.join(temp.root, "home-alias")
  await fs.symlink(temp.root, alias, "junction")
  const generation = (await InstallationGenerations.current(alias))!
  const {
    components: [component],
    features,
  } = await loadInstalledComponents(generation)
  const plan = (entry: string) =>
    JSON.stringify({ apiVersion: 2, agent: [{ id: "example", version: "2.0.0", entry }], policy: [], features })
  await verifyInstalledWorkerPlan(generation, plan(component!.workers!.agent!.href))
  expect(generation.directory).toBe(await fs.realpath(generation.directory))
  await expect(verifyInstalledWorkerPlan(generation, plan(pathToFileURL(temp.entry).href))).rejects.toThrow()
})

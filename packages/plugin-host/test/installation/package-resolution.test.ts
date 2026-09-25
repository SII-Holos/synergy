import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { preparePackageGraph } from "../../src/installation/package-resolution"

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-package-test-"))
  return { root, [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }) }
}

async function pack(root: string, name: string, synergy: unknown) {
  const directory = path.join(root, name)
  await fs.mkdir(directory)
  await Bun.write(
    path.join(directory, "package.json"),
    JSON.stringify({
      name,
      version: "2.0.0",
      type: "module",
      main: "component.js",
      synergy,
      scripts: { postinstall: `bun -e 'Bun.write(${JSON.stringify(path.join(root, "executed"))}, "bad")'` },
    }),
  )
  await Bun.write(path.join(directory, "component.js"), "throw new Error('metadata inspection must never evaluate me')")
  const archive = path.join(root, name + ".tgz")
  const child = Bun.spawn([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], {
    cwd: directory,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  if (code) throw new Error(stderr)
  return archive
}

const base = { formatVersion: 1, version: "2.0.0", compatibility: { synergy: "^2.0.0" } }

test("resolves a local preset and its component without scripts or code evaluation", async () => {
  await using temp = await fixture()
  const component = await pack(temp.root, "esbuild", {
    ...base,
    kind: "component",
    id: "example",
    apiVersion: 1,
    entry: "./component.js",
    export: "example",
  })
  const preset = await pack(temp.root, "example-preset", {
    ...base,
    kind: "preset",
    id: "example-preset",
    packages: { esbuild: "file:" + component },
  })
  await using prepared = await preparePackageGraph(temp.root, { sources: [preset], hostVersion: "2.0.0" })
  expect(Object.keys(prepared.roots)).toEqual(["example-preset"])
  expect(prepared.packages["esbuild"]?.metadata?.kind).toBe("component")
  expect(prepared.packages["example-preset"]?.metadata?.kind).toBe("preset")
  expect(await Bun.file(path.join(temp.root, "executed")).exists()).toBe(false)
})

test("rejects incompatible metadata and cleans up the failed staging graph", async () => {
  await using temp = await fixture()
  const component = await pack(temp.root, "incompatible-component", {
    ...base,
    kind: "component",
    id: "incompatible",
    apiVersion: 1,
    entry: "./component.js",
    export: "example",
  })
  await expect(preparePackageGraph(temp.root, { sources: [component], hostVersion: "3.0.0" })).rejects.toThrow(
    "requires Synergy",
  )
  expect(await fs.readdir(path.join(temp.root, "installations/staging"))).toEqual([])
  expect(await Bun.file(path.join(temp.root, "executed")).exists()).toBe(false)
})

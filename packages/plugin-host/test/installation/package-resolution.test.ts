import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { preparePackageGraph } from "../../src/installation/package-resolution"
import { InstallationGenerations } from "../../src/installation/generations"

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

test("package sources cannot become package-manager options", async () => {
  await using temp = await fixture()
  for (const source of ["--dry-run", "npm:--dry-run"])
    await expect(preparePackageGraph(temp.root, { sources: [source], hostVersion: "2.0.0" })).rejects.toThrow(
      "Package source",
    )
  expect(await fs.readdir(path.join(temp.root, "installations/staging"))).toEqual([])
})

test.skipIf(process.platform === "win32")(
  "cancelling Git resolution drains its owned subprocesses before removing the stage",
  async () => {
    await using temp = await fixture()
    const script = path.join(temp.root, "ssh")
    const receipt = path.join(temp.root, "children.json")
    await Bun.write(
      script,
      `#!${process.execPath}\nconst child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }); await Bun.write(${JSON.stringify(receipt)}, JSON.stringify([process.pid, child.pid])); await child.exited;`,
    )
    await fs.chmod(script, 0o755)
    const controller = new AbortController()
    const pending = preparePackageGraph(temp.root, {
      sources: ["git+ssh://git@localhost/synergy-fixture.git"],
      hostVersion: "2.0.0",
      signal: controller.signal,
      env: { ...process.env, GIT_SSH_COMMAND: script, GIT_SSH_VARIANT: "ssh" },
    })
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    let children: number[] = []
    try {
      const deadline = Date.now() + 8000
      while (!(await Bun.file(receipt).exists()) && Date.now() < deadline) await Bun.sleep(10)
      children = await Bun.file(receipt).json()
      controller.abort()
      expect(await outcome).toBeInstanceOf(DOMException)
      for (const pid of children) expect(() => process.kill(pid, 0)).toThrow()
      expect(await fs.readdir(path.join(temp.root, "installations/staging"))).toEqual([])
    } finally {
      controller.abort()
      for (const pid of children) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      await outcome
    }
  },
  15_000,
)

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

test("adding and removing roots preserves pinned preset dependencies and the running generation", async () => {
  await using temp = await fixture()
  const component = await pack(temp.root, "selected-component", {
    ...base,
    kind: "component",
    id: "selected",
    apiVersion: 1,
    entry: "./component.js",
    export: "example",
  })
  const preset = await pack(temp.root, "selected-preset", {
    ...base,
    kind: "preset",
    id: "selected-preset",
    packages: { "selected-component": "file:" + component },
  })
  await using first = await preparePackageGraph(temp.root, { sources: [preset], hostVersion: "2.0.0" })
  const current = await InstallationGenerations.commit(temp.root, {
    ...first,
    hostVersion: "2.0.0",
    trustHostCode: true,
  })
  await fs.rm(component)
  await fs.rm(preset)
  const extra = await pack(temp.root, "extra-preset", { ...base, kind: "preset", id: "extra", packages: {} })
  await using next = await preparePackageGraph(temp.root, { sources: [extra], hostVersion: "2.0.0", previous: current })
  expect(Object.keys(next.roots).sort()).toEqual(["extra-preset", "selected-preset"])
  expect(next.packages["selected-component"].version).toBe("2.0.0")
  expect((await InstallationGenerations.current(temp.root))?.id).toBe(current.id)
  await expect(
    preparePackageGraph(temp.root, {
      sources: [],
      hostVersion: "2.0.0",
      previous: current,
      remove: ["selected-component"],
    }),
  ).rejects.toThrow("required by")
  await using removed = await preparePackageGraph(temp.root, {
    sources: [],
    hostVersion: "2.0.0",
    previous: current,
    remove: ["selected-preset"],
  })
  expect(removed.roots).toEqual({})
  expect(removed.packages).toEqual({})
  expect(await Bun.file(path.join(current.directory, "node_modules/selected-component/component.js")).exists()).toBe(
    true,
  )
  expect(await Bun.file(path.join(removed.directory, "node_modules/selected-component/component.js")).exists()).toBe(
    false,
  )
})

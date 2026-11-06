import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PackedArchive } from "../../../script/package-install-check"
import { modulePublishOrder, publishPackedArchives } from "../../../script/release/shared/publish-modules"
import { packPublicationDirectory } from "../../../script/release/shared/publish-generic"

const archive = (id: string, dependencies: Record<string, string> = {}, optionalDependencies = {}): PackedArchive => ({
  name: `@ericsanchezok/synergy-${id}`,
  version: "4.0.0",
  archive: `${id}.tgz`,
  manifest: { dependencies, optionalDependencies },
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function packedArchives(packages: PackedArchive[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-publication-queue-"))
  directories.push(directory)
  for (const pkg of packages) {
    const dir = path.join(directory, path.basename(pkg.name))
    await Bun.write(
      path.join(dir, "package.json"),
      JSON.stringify({ ...pkg.manifest, name: pkg.name, version: pkg.version }),
    )
    const packed = await packPublicationDirectory({ ...pkg, dir, archive: path.join(directory, pkg.archive) })
    pkg.archive = packed.archive
  }
  return packages
}

test("publishes required and optional first-party dependencies before their consumers", () => {
  const native = archive("native-darwin-arm64")
  const harness = archive("harness", {}, { [native.name]: native.version })
  const cli = archive("cli", { [harness.name]: harness.version })
  expect(modulePublishOrder([cli, harness, native]).map((pkg) => pkg.name)).toEqual([
    native.name,
    harness.name,
    cli.name,
  ])
})

test("rejects missing, duplicate, mismatched and cyclic publication inputs", () => {
  const harness = archive("harness")
  const cli = archive("cli", { [harness.name]: harness.version })
  expect(() => modulePublishOrder([cli])).toThrow("Missing")
  expect(() => modulePublishOrder([harness, harness])).toThrow("Duplicate")
  expect(() => modulePublishOrder([archive("cli", { [harness.name]: "3.0.0" }), harness])).toThrow("version")
  expect(() => modulePublishOrder([cli, archive("harness", { [cli.name]: cli.version })])).toThrow("cycle")
})

test("only Desktop application publication can be explicitly deferred until signed artifacts exist", () => {
  const desktop = archive("desktop", { "@ericsanchezok/synergy-desktop-app": "4.0.0" })
  expect(() => modulePublishOrder([desktop])).toThrow("Missing")
  expect(modulePublishOrder([desktop], ["@ericsanchezok/synergy-desktop-app"])).toEqual([desktop])
})

test("overlaps at most four publications and starts ready consumers without waiting for an unrelated batch", async () => {
  const first = archive("first")
  const second = archive("second")
  const consumer = archive("consumer", { [first.name]: first.version }, { [second.name]: second.version })
  const third = archive("third")
  const fourth = archive("fourth")
  const fifth = archive("fifth")
  const packages = await packedArchives([consumer, first, second, third, fourth, fifth])
  const starts = new Map(packages.map((pkg) => [pkg.name, Promise.withResolvers<void>()]))
  const releases = new Map(packages.map((pkg) => [pkg.name, Promise.withResolvers<void>()]))
  const started: string[] = []
  const active = new Set<string>()
  let maximum = 0
  const finished = publishPackedArchives(packages, "4.0.0", "next", {
    publish: async (pkg, channel) => {
      expect(channel).toBe("next")
      started.push(pkg.name)
      active.add(pkg.name)
      maximum = Math.max(maximum, active.size)
      starts.get(pkg.name)!.resolve()
      await releases.get(pkg.name)!.promise
      active.delete(pkg.name)
    },
  })
  try {
    await starts.get(first.name)!.promise
    expect(active).toEqual(new Set([first.name, second.name, third.name, fourth.name]))
    releases.get(first.name)!.resolve()
    await starts.get(fifth.name)!.promise
    expect(started).not.toContain(consumer.name)
    releases.get(second.name)!.resolve()
    await starts.get(consumer.name)!.promise
    expect(active).toEqual(new Set([third.name, fourth.name, fifth.name, consumer.name]))
  } finally {
    for (const release of releases.values()) release.resolve()
    await finished
  }
  expect(maximum).toBe(4)
  expect(started).toHaveLength(packages.length)
  expect(new Set(started).size).toBe(packages.length)
})

test("a failed publication stops new work and drains accepted in-flight tasks before rejecting", async () => {
  const failed = archive("failed")
  const held = [archive("held-a"), archive("held-b"), archive("held-c")]
  const queued = archive("queued")
  const consumer = archive("consumer", { [failed.name]: failed.version })
  const packages = await packedArchives([failed, ...held, queued, consumer])
  const starts = new Map(packages.map((pkg) => [pkg.name, Promise.withResolvers<void>()]))
  const releases = new Map(packages.map((pkg) => [pkg.name, Promise.withResolvers<void>()]))
  const stops = new Map(packages.map((pkg) => [pkg.name, Promise.withResolvers<void>()]))
  const started: string[] = []
  const active = new Set<string>()
  const failure = new Error("registry verification failed")
  let settled = false
  const finished = publishPackedArchives(packages, "4.0.0", "next", {
    publish: async (pkg) => {
      started.push(pkg.name)
      active.add(pkg.name)
      starts.get(pkg.name)!.resolve()
      try {
        await releases.get(pkg.name)!.promise
      } finally {
        active.delete(pkg.name)
        stops.get(pkg.name)!.resolve()
      }
    },
  }).then(
    () => {
      settled = true
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    await starts.get(failed.name)!.promise
    expect(active.size).toBe(4)
    releases.get(failed.name)!.reject(failure)
    await stops.get(failed.name)!.promise
    releases.get(held[0]!.name)!.resolve()
    await stops.get(held[0]!.name)!.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(started).toEqual([failed.name, ...held.map((pkg) => pkg.name)])
    releases.get(held[1]!.name)!.reject(new Error("another in-flight failure"))
  } finally {
    for (const release of releases.values()) release.resolve()
    await finished
  }
  expect(await finished).toBe(failure)
  expect(active.size).toBe(0)
  expect(started).not.toContain(queued.name)
  expect(started).not.toContain(consumer.name)
})

test("validates every archive and selected version before the first registry write", async () => {
  const packages = await packedArchives([archive("first"), archive("last")])
  const attempted: string[] = []
  const publish = async (pkg: PackedArchive) => {
    attempted.push(pkg.name)
  }
  await expect(publishPackedArchives(packages, "3.0.0", "next", { publish })).rejects.toThrow("Stale")
  expect(attempted).toEqual([])
  await fs.rm(packages[1]!.archive)
  await expect(publishPackedArchives(packages, "4.0.0", "next", { publish })).rejects.toThrow(
    "Missing publication archive",
  )
  expect(attempted).toEqual([])
})

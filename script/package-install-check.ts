#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface PackedArchive {
  name: string
  version: string
  archive: string
  manifest: Record<string, unknown>
}

export async function withInstalledPackages<T>(
  archives: PackedArchive[],
  entries: string[],
  verify: (directory: string, env: Record<string, string | undefined>) => Promise<T>,
  options: { target?: { os: string; arch: string }; env?: Record<string, string | undefined> } = {},
): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-package-install-"))
  const env = {
    ...process.env,
    ...options.env,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: path.join(directory, ".config"),
    NODE_PATH: undefined,
    NODE_OPTIONS: undefined,
    BUN_INSTALL_CACHE_DIR: path.join(directory, "cache"),
  }
  const packages = new Map(archives.map((item) => [item.name, item]))
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const name = decodeURIComponent(url.pathname.slice(1))
      const archive = archives.find((item) => name === `archives/${path.basename(item.archive)}`)
      if (archive) return new Response(Bun.file(archive.archive))
      const pkg = packages.get(name)
      if (!pkg) return new Response("Unknown test package", { status: 404 })
      return Response.json({
        name,
        "dist-tags": { latest: pkg.version },
        versions: {
          [pkg.version]: {
            ...pkg.manifest,
            name,
            version: pkg.version,
            dist: { tarball: `${url.origin}/archives/${path.basename(pkg.archive)}` },
          },
        },
      })
    },
  })
  try {
    const dependencies = Object.fromEntries(
      entries.map((name) => {
        const pkg = packages.get(name)
        if (!pkg) throw new Error(`No archive for ${name}`)
        return [name, pkg.version]
      }),
    )
    await Bun.write(path.join(directory, "package.json"), JSON.stringify({ private: true, dependencies }))
    // Nested installers use Bun's user configuration: https://bun.com/docs/pm/npmrc
    const config = `@ericsanchezok:registry=http://127.0.0.1:${registry.port}\n`
    await Promise.all(
      [directory, env.XDG_CONFIG_HOME].map((location) => Bun.write(path.join(location, ".npmrc"), config)),
    )
    const install = Bun.spawn(
      [
        "bun",
        "install",
        "--ignore-scripts",
        "--linker=hoisted",
        "--network-concurrency",
        "8",
        ...(options.target ? ["--os", options.target.os, "--cpu", options.target.arch] : []),
      ],
      {
        cwd: directory,
        stdout: "inherit",
        stderr: "inherit",
        env,
      },
    )
    if (await install.exited) throw new Error("Installing packed workspace closure failed")
    return await verify(directory, env)
  } finally {
    registry.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

export async function readPackedArchives(archiveDirectory: string) {
  const archives: PackedArchive[] = []
  for await (const file of new Bun.Glob("*.tgz").scan(archiveDirectory)) {
    const archive = path.join(archiveDirectory, file)
    const read = Bun.spawn(["tar", "-xOf", archive, "package/package.json"], { stdout: "pipe", stderr: "inherit" })
    const manifest = JSON.parse(await new Response(read.stdout).text())
    if (await read.exited) throw new Error(`Cannot inspect ${archive}`)
    archives.push({ name: manifest.name, version: manifest.version, archive, manifest })
  }
  return archives
}

if (import.meta.main) {
  const archiveDirectory = path.resolve(process.argv[2] ?? ".artifacts/packages")
  const archives = await readPackedArchives(archiveDirectory)
  await withInstalledPackages(archives, ["@ericsanchezok/synergy-cli"], async (directory, env) => {
    const command = Bun.spawn(["bun", path.join(directory, "node_modules/.bin/synergy"), "--help"], {
      cwd: directory,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...env,
        SYNERGY_HOME: path.join(directory, "home"),
        SYNERGY_LINK_HOME: path.join(directory, "link"),
      },
    })
    if (await command.exited) throw new Error("Installed CLI failed")
    const acceptance = Bun.spawn(["bun", "test", "test/cli/artifact.test.ts"], {
      cwd: path.resolve(import.meta.dir, "../packages/cli"),
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...env,
        SYNERGY_TEST_ARTIFACT_BIN: "",
        SYNERGY_TEST_ARTIFACT_INSTALL: directory,
      },
    })
    if (await acceptance.exited) throw new Error("Installed CLI behavioral acceptance failed")
    console.log("Installed CLI tarball closure passed outside the repository")
  })
}

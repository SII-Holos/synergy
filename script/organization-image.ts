#!/usr/bin/env bun
import { access, cp, mkdir } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { nativePackageName } from "../packages/util/src/native-assets"
import { readPackedArchives, withInstalledPackages, type PackedArchive } from "./package-install-check"

const organization = "@ericsanchezok/synergy-organization"
const cli = "@ericsanchezok/synergy-cli"

export async function stageOrganizationImage(options: {
  archives: PackedArchive[]
  destination: string
  arch: "x64" | "arm64"
}) {
  const native = nativePackageName({ platform: "linux", arch: options.arch, libc: "glibc" })
  const required = [organization, cli, native].map((name) => {
    const archive = options.archives.find((item) => item.name === name)
    if (!archive) throw new Error(`Missing organization image archive: ${name}`)
    return archive
  })
  if (new Set(required.map((archive) => archive.version)).size !== 1)
    throw new Error("Organization image archives must belong to one release version")
  await access(options.destination).then(
    () => {
      throw new Error("Organization image destination must not exist")
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    },
  )
  await withInstalledPackages(
    options.archives,
    [organization, cli, native],
    async (directory) => {
      await access(path.join(directory, "node_modules/.bin/synergy-org"), constants.X_OK)
      for (const component of ["library", "browser-runtime", "computer-runtime", "presets"]) {
        if (
          await Bun.file(
            path.join(directory, "node_modules/@ericsanchezok", `synergy-${component}`, "package.json"),
          ).exists()
        )
          throw new Error(`Organization service image contains an unrelated product component: ${component}`)
      }
      await mkdir(options.destination)
      await cp(path.join(directory, "node_modules"), path.join(options.destination, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      })
      await cp(
        path.resolve(import.meta.dir, "../packages/organization/deploy/Dockerfile"),
        path.join(options.destination, "Dockerfile"),
      )
      await Bun.write(
        path.join(options.destination, "release.json"),
        JSON.stringify({
          version: required[0].version,
          platform: `linux/${options.arch === "x64" ? "amd64" : "arm64"}`,
          executesAgents: false,
        }) + "\n",
      )
    },
    { target: { os: "linux", arch: options.arch } },
  )
}

if (import.meta.main) {
  const [archives, destination, arch] = process.argv.slice(2)
  if (!archives || !destination || (arch !== "x64" && arch !== "arm64"))
    throw new Error("Usage: bun script/organization-image.ts <archives> <new context directory> <x64|arm64>")
  await stageOrganizationImage({
    archives: await readPackedArchives(path.resolve(archives)),
    destination: path.resolve(destination),
    arch,
  })
}

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { packWorkspace } from "../../pack-workspace"
import { readPackedArchives, withInstalledPackages, type PackedArchive } from "../../package-install-check"
import { seedInstalledCore } from "../../../packages/plugin-host/src/installation/seed"
import { presetPackage } from "../../../packages/plugin-host/src/installation/catalog"
import type { ComponentPackage } from "../../../packages/plugin/src/package"
import { WEB_DIST_DIR, type RuntimeArtifactProfile } from "./packages"
import type { SandboxRuntimeTarget } from "./build/sandbox-assets"
import { nativePackageName } from "../../../packages/util/src/native-assets"
import type { PackageJson } from "./package-manifest"
import { NATIVE_TARGETS } from "./native-package"

async function packGenerated(
  directory: string,
  output: string,
  manifest: PackageJson & { name: string; version: string },
) {
  await Bun.write(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2))
  const archive = path.join(output, `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`)
  const child = Bun.spawn(["bun", "pm", "pack", "--ignore-scripts", "--filename", archive], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code) throw new Error(`Packing ${manifest.name} failed: ${stderr}`)
  return archive
}

export async function prepareModuleArchives(options: {
  profile: RuntimeArtifactProfile
  version: string
  output: string
  targets: SandboxRuntimeTarget[]
}) {
  await fs.rm(options.output, { recursive: true, force: true })
  await packWorkspace(options.profile === "core" ? "packages/cli" : "packages/presets", options.output, {
    targets: options.targets,
    version: options.version,
  })
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-selections-"))
  try {
    for (const id of options.profile === "core" ? (["core"] as const) : (["core", "full", "web", "desktop"] as const)) {
      const directory = path.join(stage, id)
      await packGenerated(directory, options.output, presetPackage(id, options.version))
    }
    if (options.profile === "full") {
      const directory = path.join(stage, "web-app")
      await fs.cp(WEB_DIST_DIR, path.join(directory, "app"), { recursive: true })
      await Bun.write(
        path.join(directory, "index.js"),
        [
          'import { fileURLToPath } from "node:url";',
          'import { webApp } from "@ericsanchezok/synergy-server/web-app";',
          'export function webApplication() { return webApp({ directory: fileURLToPath(new URL("./app", import.meta.url)) }); }',
        ].join("\n"),
      )
      const dependencies = { "@ericsanchezok/synergy-server": options.version }
      const synergy: ComponentPackage = {
        formatVersion: 1,
        kind: "component",
        id: "web-app",
        version: options.version,
        compatibility: { synergy: options.version },
        apiVersion: 1,
        entry: "./index.js",
        export: "webApplication",
        requires: { server: options.version },
        packages: dependencies,
      }
      await packGenerated(directory, options.output, {
        name: "@ericsanchezok/synergy-web-app",
        version: options.version,
        type: "module",
        license: "MIT",
        exports: { ".": "./index.js" },
        dependencies,
        synergy,
      })
    }
    return readPackedArchives(options.output)
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

export async function stageModuleSeed(options: {
  profile: RuntimeArtifactProfile
  version: string
  archives: PackedArchive[]
  target: SandboxRuntimeTarget
  destination: string
}) {
  const selection = options.profile === "full" ? "web" : "core"
  const name = `@ericsanchezok/synergy-${selection}`
  const cli = "@ericsanchezok/synergy-cli"
  await withInstalledPackages(
    options.archives,
    [cli, name],
    async (directory) => {
      const native = nativePackageName({
        platform: options.target.os,
        arch: options.target.arch,
        libc: options.target.abi ?? "glibc",
      })
      const archive = options.archives.find((item) => item.name === native)
      if (!archive) throw new Error(`The module seed is missing its native target: ${native}`)
      for (const target of NATIVE_TARGETS)
        await fs.rm(
          path.join(
            directory,
            "node_modules",
            nativePackageName({ platform: target.os, arch: target.arch, libc: target.abi ?? "glibc" }),
          ),
          { recursive: true, force: true },
        )
      const destination = path.join(directory, "node_modules", native)
      await fs.mkdir(destination, { recursive: true })
      const extracted = Bun.spawn(["tar", "-xzf", archive.archive, "--strip-components=1", "-C", destination], {
        stdout: "ignore",
        stderr: "pipe",
      })
      const [code, stderr] = await Promise.all([extracted.exited, new Response(extracted.stderr).text()])
      if (code) throw new Error(`Native module extraction failed: ${stderr}`)
      if (options.target.abi === "musl") {
        await fs.rm(path.join(directory, "node_modules", `@ast-grep/cli-linux-${options.target.arch}-gnu`), {
          recursive: true,
          force: true,
        })
        await fs.rm(path.join(directory, "node_modules", `sqlite-vec-linux-${options.target.arch}`), {
          recursive: true,
          force: true,
        })
      }
      const generation = await seedInstalledCore(
        path.join(directory, "seed"),
        path.join(directory, "node_modules", cli),
        options.version,
        {
          roots: { [name]: options.version },
        },
      )
      await fs.rm(options.destination, { recursive: true, force: true })
      await fs.cp(generation.directory, options.destination, { recursive: true, dereference: true })
    },
    { target: options.target },
  )
}

#!/usr/bin/env bun

import path from "path"
import fs from "fs"
import os from "os"
import { $ } from "bun"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import pkg from "../package.json"
import { Script } from "@ericsanchezok/synergy-script"
import {
  assertPackagedSandboxAsset,
  copySandboxAsset,
  resolveSandboxAsset,
  type SandboxRuntimeTarget,
} from "./sandbox-assets"
import { copyHolosCliAsset } from "./holos-cli-assets"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const requireSandboxAssets = process.env.SYNERGY_REQUIRE_SANDBOX_ASSETS === "1"
const browserHostPublicKey = process.env.SYNERGY_BROWSER_HOST_PUBLIC_KEY ?? ""
if (process.env.SYNERGY_REQUIRE_BROWSER_HOST_PUBLIC_KEY === "1" && !browserHostPublicKey) {
  throw new Error("SYNERGY_BROWSER_HOST_PUBLIC_KEY is required for a product release build")
}
const requestedTargets = new Set(
  (process.env.SYNERGY_BUILD_TARGETS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
)

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets =
  requestedTargets.size > 0
    ? allTargets.filter((item) => requestedTargets.has(targetKey(item)))
    : singleFlag
      ? allTargets.filter((item) => {
          if (item.os !== process.platform || item.arch !== process.arch) {
            return false
          }

          // When building for the current platform, prefer a single native binary by default.
          // Baseline binaries require additional Bun artifacts and can be flaky to download.
          if (item.avx2 === false) {
            return baselineFlag
          }

          return true
        })
      : allTargets

if (targets.length === 0) {
  throw new Error(`No Synergy build targets matched SYNERGY_BUILD_TARGETS=${process.env.SYNERGY_BUILD_TARGETS}`)
}

fs.rmSync("dist", { recursive: true, force: true })

console.log("building web app")
await $`bun run --cwd ${path.resolve(dir, "../app")} build`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await ensureNativeBuildPackages()
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  if (shouldReusePublishedRuntime(item)) {
    await extractPublishedRuntimePackage(name, Script.version)
    copyHolosCliAsset(path.join("dist", name))
    if (requireSandboxAssets) assertPackagedSandboxAsset(item, path.join("dist", name))
    binaries[name] = Script.version
    continue
  }

  const sandboxAsset = resolveSandboxAsset(item, { required: requireSandboxAssets })

  await $`mkdir -p dist/${name}/bin`

  await retryBuild(name, () =>
    Bun.build({
      conditions: ["browser"],
      tsconfig: "./tsconfig.json",
      sourcemap: "external",
      external: ["@aws-sdk/client-s3", "chromium-bidi", "chromium-bidi/*"],
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        //@ts-ignore (bun types aren't up to date)
        autoloadTsconfig: true,
        autoloadPackageJson: true,
        target: name.replace(pkg.name, "bun") as any,
        outfile: `dist/${name}/bin/synergy`,
        execArgv: [`--user-agent=synergy/${Script.version}`, "--use-system-ca", "--"],
        windows: {},
      },
      entrypoints: ["./src/index.ts"],
      define: {
        SYNERGY_VERSION: `'${Script.version}'`,
        SYNERGY_CHANNEL: `'${Script.channel}'`,
        SYNERGY_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
        SYNERGY_BROWSER_HOST_PUBLIC_KEY: JSON.stringify(browserHostPublicKey),
        SYNERGY_SANDBOX_HELPER_SHA256: JSON.stringify(sandboxAsset?.sha256 ?? ""),
      },
    }),
  )

  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  copyHolosCliAsset(path.join("dist", name))
  binaries[name] = Script.version

  if (sandboxAsset) {
    copySandboxAsset(sandboxAsset, path.join("dist", name))
  } else if (item.os !== "darwin") {
    console.warn(`Sandbox asset is unavailable for ${targetKey(item)} — packaged runtime will not include a helper.`)
  }
}

function targetKey(item: SandboxRuntimeTarget): string {
  return [item.os, item.arch, item.avx2 === false ? "baseline" : undefined, item.abi].filter(Boolean).join("-")
}

type BunBuildOutput = Awaited<ReturnType<typeof Bun.build>>

async function retryBuild(name: string, build: () => Promise<BunBuildOutput>) {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const output = await build()
      if (output.success) return output
      throw new Error(output.logs.map((log) => log.message).join("\n") || `Bun build failed for ${name}`)
    } catch (error) {
      lastError = error
      if (attempt === 3) break
      console.warn(`building ${name} failed on attempt ${attempt}/3; retrying in 5s`)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  throw lastError
}

async function ensureNativeBuildPackages() {
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  } as Record<string, string>
  const packages = Object.entries(dependencies).filter(
    ([name]) => name.startsWith("@parcel/watcher-") || name.startsWith("sqlite-vec-"),
  )

  for (const [name, version] of packages) {
    await ensureNpmPackageExtracted(name, version)
  }
}

async function ensureNpmPackageExtracted(name: string, version: string) {
  const destination = path.join(dir, "node_modules", ...name.split("/"))
  if (fs.existsSync(path.join(destination, "package.json"))) return

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-native-package-"))
  try {
    await retryCommand(name, () => $`npm pack ${`${name}@${version}`} --silent`.cwd(temp).quiet())
    const tarball = fs.readdirSync(temp).find((entry) => entry.endsWith(".tgz"))
    if (!tarball) {
      throw new Error(`npm pack did not produce a tarball for ${name}@${version}`)
    }

    fs.mkdirSync(destination, { recursive: true })
    await $`tar -xzf ${path.join(temp, tarball)} -C ${destination} --strip-components=1`
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function shouldReusePublishedRuntime(item: { os: string; arch: string }): boolean {
  return process.env.SYNERGY_REUSE_PUBLISHED_RUNTIME === "1" && item.os === "win32" && item.arch === "arm64"
}

async function extractPublishedRuntimePackage(name: string, version: string) {
  const packageName = `@ericsanchezok/${name}`
  const destination = path.join(dir, "dist", name)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-runtime-package-"))
  try {
    console.log(`reusing published runtime package ${packageName}@${version}`)
    await retryCommand(packageName, () => $`npm pack ${`${packageName}@${version}`} --silent`.cwd(temp).quiet())
    const tarball = fs.readdirSync(temp).find((entry) => entry.endsWith(".tgz"))
    if (!tarball) {
      throw new Error(`npm pack did not produce a tarball for ${packageName}@${version}`)
    }

    fs.rmSync(destination, { recursive: true, force: true })
    fs.mkdirSync(destination, { recursive: true })
    await $`tar -xzf ${path.join(temp, tarball)} -C ${destination} --strip-components=1`
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

async function retryCommand(name: string, command: () => Promise<unknown>) {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await command()
      return
    } catch (error) {
      lastError = error
      if (attempt === 3) break
      console.warn(`installing ${name} failed on attempt ${attempt}/3; retrying in 5s`)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
  throw lastError
}

export { binaries }

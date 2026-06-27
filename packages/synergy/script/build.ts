#!/usr/bin/env bun

import path from "path"
import fs from "fs"
import { $ } from "bun"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import pkg from "../package.json"
import { Script } from "@ericsanchezok/synergy-script"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
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
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" sqlite-vec@${pkg.dependencies["sqlite-vec"]}`
  // Explicitly install platform-specific sqlite-vec packages with --os="*" --cpu="*"
  // so they are available for all cross-platform builds (without these flags, bun only
  // installs the current platform's variant)
  const sqliteVecVersion = pkg.dependencies["sqlite-vec"]
  const sqliteVecPlatforms = [
    "sqlite-vec-darwin-arm64",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-linux-arm64",
    "sqlite-vec-linux-x64",
    "sqlite-vec-windows-x64",
  ]
  for (const vecPkg of sqliteVecPlatforms) {
    await $`bun install --os="*" --cpu="*" ${vecPkg}@${sqliteVecVersion}`
  }
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
  binaries[name] = Script.version

  // Copy sandbox helper into dist for tarball embedding
  await copySandboxHelper(item, name)
}

async function copySandboxHelper(item: { os: string; arch: string }, name: string): Promise<void> {
  // macOS uses sandbox-exec built into the OS — no helper needed
  if (item.os === "darwin") return

  let helperSrc: string
  let helperDest: string

  if (item.os === "linux") {
    const helperDir = path.resolve(dir, "src", "sandbox", "helper-linux", "target", "release")
    helperSrc = path.join(helperDir, "synergy-sandbox-linux")
    helperDest = path.join("dist", name, "sandbox", "synergy-sandbox-linux")
  } else if (item.os === "win32") {
    const helperDir = path.resolve(dir, "src", "sandbox", "helper", "target", "release")
    helperSrc = path.join(helperDir, "synergy-sandbox-windows.exe")
    helperDest = path.join("dist", name, "sandbox", "synergy-sandbox-windows.exe")
  } else {
    return
  }

  if (!fs.existsSync(helperSrc)) {
    console.warn(`Sandbox helper not found at ${helperSrc} — skipping embed. Build the Rust helper first.`)
    return
  }

  console.log(`Copying sandbox helper: ${helperSrc} → ${helperDest}`)
  fs.mkdirSync(path.dirname(helperDest), { recursive: true })
  fs.copyFileSync(helperSrc, helperDest)
}

function targetKey(item: { os: string; arch: string; abi?: string; avx2?: false }): string {
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

export { binaries }

#!/usr/bin/env bun

import path from "path"

const dir = path.resolve(import.meta.dir, "..")

process.chdir(dir)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")

const version = process.env.META_SYNERGY_VERSION ?? "0.0.0-dev"

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  // Linux glibc
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  // Linux musl
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  // macOS
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  // Windows
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) return false
      if (item.avx2 === false) return baselineFlag
      return !item.abi
    })
  : allTargets

await Bun.write(Bun.stdout, `building ${targets.length} meta-synergy target(s)\n`)
await Bun.$`rm -rf dist`

for (const item of targets) {
  const name = buildName(item)
  const bunTarget = buildBunTarget(item)
  const binaryName = item.os === "win32" ? "meta-synergy.exe" : "meta-synergy"

  console.log(`building ${name} (${bunTarget})`)
  await Bun.$`mkdir -p dist/${name}/bin`

  await Bun.build({
    entrypoints: ["./src/cli.ts"],
    compile: {
      target: bunTarget as any,
      outfile: `dist/${name}/bin/${binaryName}`,
      autoloadBunfig: false,
      autoloadDotenv: false,
    },
    define: {
      META_SYNERGY_VERSION: `'${version}'`,
    },
  })
}

function buildName(item: (typeof allTargets)[number]): string {
  return [
    "meta-synergy",
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
}

function buildBunTarget(item: (typeof allTargets)[number]): string {
  return [
    "bun",
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
}

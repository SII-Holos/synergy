import path from "node:path"
import { z } from "zod"
import { format, resolveConfig } from "prettier"
import fs from "node:fs"
import os from "node:os"
import { $ } from "bun"
import { APP_DIR, CLI_DIR, PRODUCT_RUNTIME_DIR, RUNTIME_RELEASE_TARGETS, type RuntimeArtifactProfile } from "./packages"
import {
  assertPackagedSandboxAsset,
  copySandboxAsset,
  resolveSandboxAsset,
  type SandboxRuntimeTarget,
} from "./build/sandbox-assets"
import { prepareBuildModelsCatalog } from "./build/models-catalog"
import { nativePlatformPackageNames } from "./build/native-build-packages"
import { runtimeDependencies, prepareRuntimeAssets } from "./runtime-assets"
import { runtimeBuildPlan } from "./runtime-build-plan"

export async function buildRuntime(profile: RuntimeArtifactProfile) {
  const dir = profile === "core" ? CLI_DIR : PRODUCT_RUNTIME_DIR
  process.chdir(dir)
  const plan = runtimeBuildPlan(profile)
  const executable = RUNTIME_RELEASE_TARGETS[profile].executable
  const buildCommit = (await $`git rev-parse --verify HEAD`.quiet().nothrow()).text().trim()
  const { Script } = await import("./build/script-identity")
  const singleFlag = process.argv.includes("--single")
  const baselineFlag = process.argv.includes("--baseline")
  const skipInstall = process.argv.includes("--skip-install")
  const requireSandboxAssets = process.env.SYNERGY_REQUIRE_SANDBOX_ASSETS === "1"
  const browserManifestPublicKey =
    process.env.SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY ?? process.env.SYNERGY_BROWSER_HOST_PUBLIC_KEY ?? ""
  if (profile === "full" && process.env.SYNERGY_REQUIRE_BROWSER_HOST_PUBLIC_KEY === "1" && !browserManifestPublicKey) {
    throw new Error("SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY is required for a product release build")
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

  const modelsCatalog = await prepareBuildModelsCatalog()
  console.log(`using ${modelsCatalog.source} models catalog (${modelsCatalog.providerCount} providers)`)
  await generateSchema(dir, profile)

  fs.rmSync("dist", { recursive: true, force: true })

  if (profile === "full") {
    console.log("building web app")
    await $`bun run --cwd ${APP_DIR} build`
  }

  const binaries: Record<string, string> = {}
  if (!skipInstall) {
    await ensureNativeBuildPackages()
  }
  for (const item of targets) {
    const name = [
      executable,
      // changing to win32 flags npm for some reason
      item.os === "win32" ? "windows" : item.os,
      item.arch,
      item.avx2 === false ? "baseline" : undefined,
      item.abi === undefined ? undefined : item.abi,
    ]
      .filter(Boolean)
      .join("-")
    console.log(`building ${name}`)
    if (profile === "full" && shouldReusePublishedRuntime(item)) {
      await extractPublishedRuntimePackage(name, Script.version)
      await stageProductAssets(path.join("dist", name))
      if (requireSandboxAssets) assertPackagedSandboxAsset(item, path.join("dist", name))
      binaries[name] = Script.version
      await prepareRuntimeAssets(name, profile)
      continue
    }

    const sandboxAsset = resolveSandboxAsset(item, { required: requireSandboxAssets })

    await $`mkdir -p dist/${name}/bin`

    await retryBuild(name, async () =>
      Bun.build({
        conditions: ["browser"],
        tsconfig: "./tsconfig.json",
        sourcemap: "external",
        external: plan.external,
        plugins:
          profile === "full"
            ? [
                (
                  await import("../../../packages/library/script/embedding-runtime-assets")
                ).standaloneEmbeddingBuildPlugin(),
              ]
            : [],
        compile: {
          autoloadBunfig: false,
          autoloadDotenv: false,
          //@ts-ignore (bun types aren't up to date)
          autoloadTsconfig: true,
          autoloadPackageJson: true,
          target: name.replace(executable, "bun") as Bun.Build.CompileTarget,
          outfile: `dist/${name}/bin/${executable}`,
          execArgv: [`--user-agent=synergy/${Script.version}`, "--use-system-ca", "--"],
          windows: {},
        },
        entrypoints: plan.entrypoints,
        define: {
          SYNERGY_COMMIT: JSON.stringify(/^[a-f0-9]{40,64}$/.test(buildCommit) ? buildCommit : ""),
          SYNERGY_VERSION: JSON.stringify(Script.version),
          SYNERGY_CHANNEL: JSON.stringify(Script.channel),
          SYNERGY_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
          SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY: JSON.stringify(browserManifestPublicKey),
          SYNERGY_SANDBOX_HELPER_SHA256: JSON.stringify(sandboxAsset?.sha256 ?? ""),
          SYNERGY_STANDALONE: "true",
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
    if (profile === "full") await stageProductAssets(path.join("dist", name))

    if (sandboxAsset) {
      copySandboxAsset(sandboxAsset, path.join("dist", name))
    } else if (item.os !== "darwin") {
      console.warn(`Sandbox asset is unavailable for ${targetKey(item)} — packaged runtime will not include a helper.`)
    }
    await prepareRuntimeAssets(name, profile)
  }
  return binaries

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
    const dependencies = await runtimeDependencies(profile)
    const packages = nativePlatformPackageNames(dependencies)
      .filter((name) => profile === "full" || name.startsWith("@parcel/watcher-"))
      .map((name) => [name, dependencies[name]] as const)

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
}

async function stageProductAssets(runtimeDir: string) {
  const [playwright, embedding, svg, holos] = await Promise.all([
    import("../../../packages/product-runtime/script/playwright-runtime-assets"),
    import("../../../packages/library/script/embedding-runtime-assets"),
    import("../../../packages/connections/script/svg-raster-runtime-assets"),
    import("../../../packages/connections/script/holos-cli-assets"),
  ])
  await Promise.all([
    playwright.stagePlaywrightCoreRuntime({ runtimeDir }),
    embedding.stageEmbeddingRuntimeAssets({ runtimeDir }),
    svg.stageSvgRasterRuntimeAssets({ runtimeDir }),
  ])
  holos.copyHolosCliAsset(runtimeDir)
}

export async function generateSchema(directory: string, profile: RuntimeArtifactProfile) {
  if (profile === "full") await import("../../../packages/product-runtime/src/configuration")
  else await import("../../../packages/runtime-local/src/config-schema")
  const { Config } = await import("../../../packages/harness/src/config/config")
  const schema = z.toJSONSchema(Config.schema(), { unrepresentable: "any" })
  if (schema.properties) {
    delete schema.properties.keybinds
    delete schema.properties.experimental
  }
  const output = path.join(directory, "schema/config.schema.json")
  const options = await resolveConfig(
    path.join(profile === "core" ? CLI_DIR : PRODUCT_RUNTIME_DIR, "schema/config.schema.json"),
  )
  await Bun.write(output, await format(JSON.stringify(schema), { ...options, parser: "json" }))
}

import z from "zod"
import { Global } from "../global"
import { Log } from "../util/log"
import path from "path"
import { existsSync } from "fs"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { readableStreamToText } from "bun"
import { createRequire } from "module"
import { Lock } from "../util/lock"
import { PluginSpec } from "./plugin-spec"

export namespace BunProc {
  const log = Log.create({ service: "bun" })

  export async function run(cmd: string[], options?: Bun.SpawnOptions.OptionsObject<any, any, any>) {
    log.info("running", {
      cmd: [which(), ...cmd],
      ...options,
    })
    const result = Bun.spawn([which(), ...cmd], {
      ...options,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options?.env,
        BUN_BE_BUN: "1",
      },
    })
    const code = await result.exited
    const stdout = result.stdout
      ? typeof result.stdout === "number"
        ? result.stdout
        : await readableStreamToText(result.stdout)
      : undefined
    const stderr = result.stderr
      ? typeof result.stderr === "number"
        ? result.stderr
        : await readableStreamToText(result.stderr)
      : undefined
    log.info("done", {
      code,
      stdout,
      stderr,
    })
    if (code !== 0) {
      throw new Error(`Command failed with exit code ${result.exitCode}`)
    }
    return result
  }

  export function which() {
    return process.execPath
  }

  export const InstallFailedError = NamedError.create(
    "BunInstallFailedError",
    z.object({
      pkg: z.string(),
      version: z.string(),
    }),
  )

  /** Resolve the actual package name from the lockfile for non-registry specs. */
  export function resolvePkgName(spec: string): string {
    try {
      const lockfilePath = path.join(Global.Path.cache, "bun.lock")
      const content = JSON.parse(require("fs").readFileSync(lockfilePath, "utf-8"))
      if (content?.workspaces) {
        for (const workspace of Object.values(content.workspaces) as any[]) {
          if (!workspace?.dependencies) continue
          for (const [name, value] of Object.entries(workspace.dependencies)) {
            if (value === spec || (typeof value === "string" && value.startsWith(spec + "#"))) {
              return name
            }
          }
        }
      }
    } catch {}
    // Fallback: strip protocol prefix and take the repo name
    return spec
      .replace(/^github:/, "")
      .split("/")
      .pop()!
  }

  export interface InstallResult {
    entryPath: string
    cached: boolean
  }

  export async function install(pkg: string, version = "latest"): Promise<InstallResult> {
    // Use lock to ensure only one install at a time
    using _ = await Lock.write("bun-install")

    const isNonRegistry = PluginSpec.isNonRegistry(pkg) || PluginSpec.isNonRegistry(version)

    const pkgjson = Bun.file(path.join(Global.Path.cache, "package.json"))
    const parsed = await pkgjson.json().catch(async () => {
      const result = { dependencies: {} }
      await Bun.write(pkgjson.name!, JSON.stringify(result, null, 2))
      return result
    })
    const existing = parsed.dependencies[pkg]
    const cached = modPath(pkg, isNonRegistry)
    // For registry packages: exact version match means cached.
    // For non-registry packages (github:, git+, etc.): if any dependency
    // entry exists, consider it cached — Bun resolves the ref on install
    // and we don't want to re-install on every startup.
    // In both cases, verify the directory actually exists to guard against
    // a partially failed prior install that left a stale cache entry.
    const dirExists = existsSync(cached)
    if (dirExists && existing === version) return { entryPath: resolveEntry(cached, pkg, isNonRegistry), cached: true }
    if (dirExists && existing && version === "latest")
      return { entryPath: resolveEntry(cached, pkg, isNonRegistry), cached: true }

    const proxied = !!(
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy
    )

    // For non-registry protocols, appending @version is invalid — install
    // the spec as-is unless an explicit non-latest version is provided.
    const target = isNonRegistry ? (version && version !== "latest" ? pkg + "@" + version : pkg) : pkg + "@" + version

    // Build command arguments
    const args = [
      "add",
      "--force",
      "--exact",
      // TODO: get rid of this case (see: https://github.com/oven-sh/bun/issues/19936)
      ...(proxied ? ["--no-cache"] : []),
      "--cwd",
      Global.Path.cache,
      target,
    ]

    // Let Bun handle registry resolution:
    // - If .npmrc files exist, Bun will use them automatically
    // - If no .npmrc files exist, Bun will default to https://registry.npmjs.org
    // - No need to pass --registry flag
    log.info("installing package using Bun's default registry resolution", {
      pkg,
      version,
    })

    await BunProc.run(args, {
      cwd: Global.Path.cache,
    }).catch((e) => {
      throw new InstallFailedError(
        { pkg, version },
        {
          cause: e,
        },
      )
    })

    const mod = modPath(pkg, isNonRegistry)

    // Resolve actual version from installed package when using "latest"
    // This ensures subsequent starts use the cached version until explicitly updated
    let resolvedVersion = version
    if (version === "latest") {
      const installedPkgJson = Bun.file(path.join(mod, "package.json"))
      const installedPkg = await installedPkgJson.json().catch(() => null)
      if (installedPkg?.version) {
        resolvedVersion = installedPkg.version
      }
    }

    // For non-registry packages, write the spec itself (e.g.
    // "github:SII-Holos/holos-inspire") as the dependency value so Bun
    // can re-resolve it correctly. Writing a semver like "0.1.0" causes
    // Bun to treat it as "github:...@0.1.0" which is invalid.
    if (isNonRegistry) {
      parsed.dependencies[pkg] = pkg
    } else {
      parsed.dependencies[pkg] = resolvedVersion
    }
    await Bun.write(pkgjson.name!, JSON.stringify(parsed, null, 2))
    return { entryPath: resolveEntry(mod, pkg, isNonRegistry), cached: false }
  }

  export async function invalidateCache(pkg?: string) {
    const pkgjsonPath = path.join(Global.Path.cache, "package.json")
    const pkgjson = Bun.file(pkgjsonPath)
    const parsed = await pkgjson.json().catch(() => ({ dependencies: {} }))

    if (pkg) {
      delete parsed.dependencies[pkg]
    } else {
      parsed.dependencies = {}
    }

    await Bun.write(pkgjsonPath, JSON.stringify(parsed, null, 2))

    const lockfilePath = path.join(Global.Path.cache, "bun.lock")
    if (existsSync(lockfilePath)) {
      const { unlinkSync } = require("fs")
      unlinkSync(lockfilePath)
    }

    // Remove the actual node_modules directory so bun can't reuse stale files.
    // Without this, bun add may silently reuse cached files even after
    // clearing the lockfile (e.g. git repos without a valid remote).
    const isNonRegistry = pkg ? PluginSpec.isNonRegistry(pkg) : false
    const modDir = pkg ? modPath(pkg, isNonRegistry) : path.join(Global.Path.cache, "node_modules")
    if (pkg && existsSync(modDir)) {
      const { rmSync } = require("fs")
      rmSync(modDir, { recursive: true, force: true })
    }
  }

  /**
   * Resolve the node_modules path for an installed package.
   * For non-registry specs (github:, git+, etc.), Bun installs under
   * the package's actual name (from package.json), not the git spec —
   * so we read the lockfile to find the real directory name.
   */
  function modPath(pkg: string, isNonRegistry: boolean): string {
    const actualPkg = isNonRegistry ? resolvePkgName(pkg) : pkg
    return path.join(Global.Path.cache, "node_modules", actualPkg)
  }

  function resolveEntry(pkgDir: string, pkg: string, isNonRegistry: boolean): string {
    const actualPkg = isNonRegistry ? resolvePkgName(pkg) : pkg
    try {
      // require.resolve with a bare name resolves through node_modules
      // starting from Global.Path.cache, which is where we install packages.
      const cacheReq = createRequire(path.join(Global.Path.cache, "package.json"))
      return cacheReq.resolve(actualPkg)
    } catch {}
    // Fallback: read package.json exports/main manually
    try {
      const pkgJson = JSON.parse(require("fs").readFileSync(path.join(pkgDir, "package.json"), "utf-8"))
      const entry = pkgJson.exports?.["."] ?? pkgJson.main ?? "index.ts"
      return path.join(pkgDir, entry)
    } catch {}
    return path.join(pkgDir, "index.ts")
  }
}

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "path"

export namespace StandaloneInstallation {
  export interface Context {
    platform: NodeJS.Platform
    libc?: "glibc" | "musl"
    execPath: string
    realExecPath: string
    env?: NodeJS.ProcessEnv
  }

  export interface InstallerInvocation {
    command: string[]
    env: NodeJS.ProcessEnv
    stdin: string
  }

  export interface UpgradeResult {
    exitCode: number
    stdout: string
    stderr: string
  }

  export interface Dependencies {
    fetch(url: string): Promise<Response>
    run(invocation: InstallerInvocation): Promise<UpgradeResult>
    verify(home: string, context: Context): Promise<boolean>
  }

  export interface UpgradeOptions {
    target: string
    context: Context
  }

  export interface LibcDetectionDependencies {
    alpineReleaseExists(): Promise<boolean>
    lddVersion(): Promise<string>
  }
  const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

  export function installationHome(context: Context) {
    const pathModule = context.platform === "win32" ? path.win32 : path.posix
    const executable = pathModule.basename(context.realExecPath).toLowerCase()
    const expectedExecutable = context.platform === "win32" ? "synergy.exe" : "synergy"
    if (executable !== expectedExecutable) return null

    const binDirectory = pathModule.dirname(context.realExecPath)
    if (pathModule.basename(binDirectory).toLowerCase() !== "bin") return null

    const installationRoot = pathModule.dirname(binDirectory)
    if (pathModule.basename(installationRoot).toLowerCase() !== ".synergy") return null
    return pathModule.dirname(installationRoot)
  }

  export function detectStandaloneInstall(context: Context) {
    return installationHome(context) !== null
  }

  export async function verify(home: string, context: Context): Promise<boolean> {
    const installationRoot = path.join(home, ".synergy")
    const manifestPath = path.join(installationRoot, "runtime-manifest.sha256")
    const contents = await fs.readFile(manifestPath, "utf8").catch(() => undefined)
    const required = requiredRuntimePaths(context, contents !== undefined)
    if (contents === undefined) {
      const files = await Promise.all(required.map((relative) => runtimeFileIsSafe(installationRoot, relative)))
      return files.every(Boolean)
    }
    if (!contents) return false

    const entries = new Map<string, string>()
    for (const line of contents.trim().split("\n")) {
      const match = /^([a-f0-9]{64})  ([^/\\\s]+(?:\/[^/\\\s]+)*)$/.exec(line)
      const checksum = match?.[1]
      const relative = match?.[2]
      const components = relative?.split("/")
      if (
        !checksum ||
        !relative ||
        /^[A-Za-z]:/.test(relative) ||
        components?.some((component) => component === "." || component === "..") ||
        entries.has(relative)
      )
        return false
      entries.set(relative, checksum)
    }
    if (required.some((relative) => !entries.has(relative))) return false

    for (const [relative, checksum] of entries) {
      const filePath = path.join(installationRoot, relative)
      if (!(await runtimeFileIsSafe(installationRoot, relative))) return false
      const data = await fs.readFile(filePath).catch(() => undefined)
      if (!data || createHash("sha256").update(data).digest("hex") !== checksum) return false
    }
    return true
  }

  async function runtimeFileIsSafe(runtimeDir: string, relative: string): Promise<boolean> {
    const components = relative.split("/")
    let current = runtimeDir
    for (const [index, component] of components.entries()) {
      current = path.join(current, component)
      const info = await fs.lstat(current).catch(() => null)
      if (!info || info.isSymbolicLink()) return false
      if (index < components.length - 1 && !info.isDirectory()) return false
      if (index === components.length - 1 && !info.isFile()) return false
    }
    return true
  }

  export async function detectLibc(
    platform: NodeJS.Platform,
    dependencies: LibcDetectionDependencies = defaultLibcDetectionDependencies,
  ): Promise<Context["libc"]> {
    if (platform !== "linux") return undefined
    if (await dependencies.alpineReleaseExists()) return "musl"
    return /musl/i.test(await dependencies.lddVersion()) ? "musl" : "glibc"
  }

  export async function upgrade(options: UpgradeOptions, dependencies: Dependencies = defaultDependencies) {
    if (!VERSION_PATTERN.test(options.target)) {
      throw new Error(`Invalid Synergy version: ${options.target}`)
    }

    const home = installationHome(options.context)
    if (!home) {
      throw new Error(`Synergy executable is not a standalone installation: ${options.context.realExecPath}`)
    }

    const url = "https://raw.githubusercontent.com/SII-Holos/synergy/main/install"
    const response = await dependencies.fetch(url)
    if (!response.ok) {
      throw new Error(
        `Failed to download the Synergy ${options.target} installer: ${response.status} ${response.statusText}`,
      )
    }

    const result = await dependencies.run({
      command: ["bash", "-s", "--", "--version", options.target, "--no-modify-path"],
      env: { ...options.context.env, HOME: home },
      stdin: await response.text(),
    })
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `Synergy installer exited with code ${result.exitCode}`,
      )
    }
    if (!(await dependencies.verify(home, options.context))) {
      throw new Error(`Synergy installer left an incomplete standalone installation in ${path.join(home, ".synergy")}`)
    }
    return result
  }

  function requiredRuntimePaths(context: Context, modern: boolean): string[] {
    const nativeHelpers =
      context.platform === "win32"
        ? ["bin/ast-grep.exe", "vec0.dll"]
        : ["bin/ast-grep", context.platform === "darwin" ? "vec0.dylib" : "vec0.so"]
    const isMusl = context.platform === "linux" && context.libc === "musl"
    return [
      context.platform === "win32" ? "bin/synergy.exe" : "bin/synergy",
      "app/index.html",
      "schema/config.schema.json",
      "browser-runtime/playwright-core/package.json",
      "browser-runtime/playwright-core/index.js",
      "browser-runtime/playwright-core/lib/coreBundle.js",
      ...(modern
        ? [
            ...(!isMusl ? nativeHelpers : []),
            "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
            "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
            "lib/holos-cli/index.js",
            "lib/holos-cli/vendor/clarus-shared/index.js",
            "lib/holos-cli/node_modules/ws/package.json",
            "lib/holos-cli/node_modules/zod/package.json",
          ]
        : []),
      ...(context.platform === "linux" ? ["sandbox/synergy-sandbox-linux"] : []),
      ...(context.platform === "win32" ? ["sandbox/synergy-sandbox-windows.exe"] : []),
    ]
  }

  const defaultLibcDetectionDependencies: LibcDetectionDependencies = {
    alpineReleaseExists: () =>
      fs.access("/etc/alpine-release").then(
        () => true,
        () => false,
      ),
    async lddVersion() {
      try {
        const subprocess = Bun.spawn(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr] = await Promise.all([
          new Response(subprocess.stdout).text(),
          new Response(subprocess.stderr).text(),
          subprocess.exited,
        ])
        return `${stdout}${stderr}`
      } catch {
        return ""
      }
    },
  }

  const defaultDependencies: Dependencies = {
    fetch: (url) => fetch(url),
    async run(invocation) {
      const subprocess = Bun.spawn(invocation.command, {
        env: invocation.env,
        stdin: new Blob([invocation.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    },
    verify,
  }
}

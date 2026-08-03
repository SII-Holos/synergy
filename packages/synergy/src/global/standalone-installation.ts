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

  export interface RemoveOptions {
    home: string
    platform: NodeJS.Platform
  }

  export interface ShellConfigOptions {
    home: string
    shell?: string
    xdgConfigHome?: string
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

  export function runtimePaths(options: RemoveOptions) {
    const root = path.join(options.home, ".synergy")
    const executable = options.platform === "win32" ? "synergy.exe" : "synergy"
    const astGrep = options.platform === "win32" ? "ast-grep.exe" : "ast-grep"
    const vec0 = options.platform === "win32" ? "vec0.dll" : options.platform === "darwin" ? "vec0.dylib" : "vec0.so"
    return [
      path.join(root, "bin", executable),
      path.join(root, "bin", astGrep),
      path.join(root, "bin", ".runtime-metadata"),
      path.join(root, "app"),
      path.join(root, "browser-runtime"),
      path.join(root, "lib"),
      path.join(root, "sandbox"),
      path.join(root, "sandbox-helper"),
      path.join(root, "schema"),
      path.join(root, vec0),
      path.join(root, "runtime-manifest.sha256"),
    ]
  }

  export async function remove(options: RemoveOptions) {
    const root = path.join(options.home, ".synergy")
    const rootInfo = await fs.lstat(root).catch(() => null)
    if (rootInfo?.isSymbolicLink()) throw new Error(`Standalone installation root is a symbolic link: ${root}`)

    const removed: string[] = []
    for (const target of runtimePaths(options)) {
      await assertManagedTargetParents(root, target)
      const info = await fs.lstat(target).catch(() => null)
      if (!info) continue
      await fs.rm(target, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true })
      removed.push(target)
    }
    const bin = path.join(root, "bin")
    const entries = await fs.readdir(bin).catch(() => null)
    if (entries?.length === 0) {
      await fs.rmdir(bin)
      removed.push(bin)
    }
    return removed
  }

  async function assertManagedTargetParents(root: string, target: string) {
    let current = path.dirname(target)
    while (current !== root) {
      const info = await fs.lstat(current).catch(() => null)
      if (info?.isSymbolicLink()) throw new Error(`Standalone runtime parent is a symbolic link: ${current}`)
      current = path.dirname(current)
    }
  }

  export function shellConfigFiles(options: ShellConfigOptions) {
    const shell = path.basename(options.shell || "bash")
    const xdgConfig = options.xdgConfigHome || path.join(options.home, ".config")
    const configFiles: Record<string, string[]> = {
      fish: [path.join(xdgConfig, "fish", "config.fish")],
      zsh: [
        path.join(options.home, ".zshrc"),
        path.join(options.home, ".zshenv"),
        path.join(xdgConfig, "zsh", ".zshrc"),
        path.join(xdgConfig, "zsh", ".zshenv"),
      ],
      bash: [
        path.join(options.home, ".bashrc"),
        path.join(options.home, ".bash_profile"),
        path.join(options.home, ".profile"),
        path.join(xdgConfig, "bash", ".bashrc"),
        path.join(xdgConfig, "bash", ".bash_profile"),
      ],
      ash: [path.join(options.home, ".ashrc"), path.join(options.home, ".profile")],
      sh: [path.join(options.home, ".profile")],
    }
    return configFiles[shell] || configFiles.bash
  }

  export async function findShellConfigs(options: ShellConfigOptions) {
    const matches: string[] = []
    for (const file of shellConfigFiles(options)) {
      const content = await fs.readFile(file, "utf8").catch(() => null)
      if (content && hasStandalonePathLine(content, options.home)) matches.push(file)
    }
    return matches
  }

  export function cleanShellConfigContent(content: string, home?: string) {
    const lines = content.split("\n")
    const filtered: string[] = []
    let removeNextStandaloneLine = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === "# synergy") {
        removeNextStandaloneLine = true
        continue
      }
      if (removeNextStandaloneLine) {
        removeNextStandaloneLine = false
        if (isStandalonePathLine(trimmed, home)) continue
        filtered.push("# synergy")
      }
      if (isStandalonePathLine(trimmed, home)) continue
      filtered.push(line)
    }
    return filtered.join("\n")
  }

  export async function cleanShellConfig(file: string, home = path.dirname(file)) {
    const content = await fs.readFile(file, "utf8")
    const cleaned = cleanShellConfigContent(content, home)
    if (cleaned === content) return false
    await fs.writeFile(file, cleaned)
    return true
  }

  function hasStandalonePathLine(content: string, home: string) {
    return content.split("\n").some((line) => isStandalonePathLine(line.trim(), home))
  }

  function isStandalonePathLine(line: string, home?: string) {
    const directories = ["$HOME/.synergy/bin", ...(home ? [path.join(home, ".synergy", "bin")] : [])]
    return directories.some(
      (directory) =>
        line === `export PATH=${directory}:$PATH` ||
        line === `export PATH="${directory}:$PATH"` ||
        line === `export PATH='${directory}:$PATH'` ||
        line === `fish_add_path ${directory}` ||
        line === `fish_add_path "${directory}"` ||
        line === `fish_add_path '${directory}'`,
    )
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

    const url = `https://raw.githubusercontent.com/SII-Holos/synergy/v${options.target}/install`
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

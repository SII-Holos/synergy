import path from "path"

export namespace StandaloneInstallation {
  export interface Context {
    platform: NodeJS.Platform
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
  }

  export interface UpgradeOptions {
    target: string
    context: Context
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

    return dependencies.run({
      command: ["bash", "-s", "--", "--version", options.target, "--no-modify-path"],
      env: { ...options.context.env, HOME: home },
      stdin: await response.text(),
    })
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
  }
}

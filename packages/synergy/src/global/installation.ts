import { BusEvent } from "@/bus/bus-event"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import fs from "fs/promises"
import { DesktopInstallation } from "./desktop-installation"
import { StandaloneInstallation } from "./standalone-installation"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import os from "node:os"
import path from "node:path"

declare global {
  const SYNERGY_VERSION: string
  const SYNERGY_CHANNEL: string
  const SYNERGY_SANDBOX_HELPER_SHA256: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })
  const NPM_REGISTRY = "https://registry.npmjs.org"

  export type Method = "npm" | "yarn" | "pnpm" | "bun" | "brew" | "desktop" | "standalone" | "unknown"
  export type InstalledMethod = Exclude<Method, "unknown">

  export interface InspectionContext extends DesktopInstallation.Context {
    home: string
  }

  export interface CommandResult {
    exitCode: number
    stdout: string
    stderr: string
  }

  export interface PathCandidate extends DesktopInstallation.PathCandidate {
    realPath?: string
  }

  export interface InspectionDependencies {
    exists(candidate: string): Promise<boolean>
    run(command: string[]): Promise<CommandResult>
    pathCandidates(context: DesktopInstallation.Context): Promise<PathCandidate[]>
  }

  export interface InstalledChannel {
    method: InstalledMethod
    executable: string | null
    version: string | null
    status: "ok" | "failed"
    current: boolean
    pathFirst: boolean
  }

  export interface Inspection {
    current: Method
    conflict: boolean
    installations: InstalledChannel[]
    path: PathCandidate[]
  }

  export interface InspectOptions {
    context?: InspectionContext
    dependencies?: InspectionDependencies
  }

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return npmDistTagForChannel(CHANNEL) !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export function npmDistTagForChannel(channel: string) {
    return channel === "stable" ? "latest" : channel
  }

  export const detectDesktopInstall = DesktopInstallation.detectDesktopInstall
  export const detectStandaloneInstall = StandaloneInstallation.detectStandaloneInstall

  const installedChannelSchema = z.object({
    method: z.enum(["npm", "yarn", "pnpm", "bun", "brew", "desktop", "standalone"]),
    executable: z.string().nullable(),
    version: z.string().nullable(),
    status: z.enum(["ok", "failed"]),
    current: z.boolean(),
    pathFirst: z.boolean(),
  })

  type PackageMethod = Exclude<InstalledMethod, "desktop" | "standalone">

  const packageChecks: Array<{ method: PackageMethod; command: string[]; marker: RegExp }> = [
    { method: "npm", command: ["npm", "list", "-g", "--depth=0"], marker: /@ericsanchezok\/synergy/ },
    { method: "yarn", command: ["yarn", "global", "list"], marker: /@ericsanchezok\/synergy/ },
    { method: "pnpm", command: ["pnpm", "list", "-g", "--depth=0"], marker: /@ericsanchezok\/synergy/ },
    { method: "bun", command: ["bun", "pm", "ls", "-g"], marker: /@ericsanchezok\/synergy/ },
    { method: "brew", command: ["brew", "list", "--versions", "synergy"], marker: /(?:^|\s)synergy(?:\s|$)/m },
  ]

  export const MultipleInstallationsError = NamedError.create(
    "MultipleInstallationsError",
    z.object({ installations: z.array(installedChannelSchema) }),
  )

  export const InstallationMethodNotFoundError = NamedError.create(
    "InstallationMethodNotFoundError",
    z.object({ method: z.string(), installations: z.array(installedChannelSchema) }),
  )

  export const InstallationProbeFailedError = NamedError.create(
    "InstallationProbeFailedError",
    z.object({ method: z.string() }),
  )

  export async function inspect(options: InspectOptions = {}): Promise<Inspection> {
    const execPath = options.context?.execPath ?? process.execPath
    const realExecPath = options.context?.realExecPath ?? (await fs.realpath(execPath).catch(() => execPath))
    const context: InspectionContext = options.context ?? {
      platform: process.platform,
      execPath,
      realExecPath,
      home: os.homedir(),
      env: process.env,
    }
    const dependencies = options.dependencies ?? defaultInspectionDependencies
    const pathCandidates = await dependencies.pathCandidates(context).catch(() => [])
    const firstPath = pathCandidates[0]?.realPath ?? pathCandidates[0]?.path
    const installations: InstalledChannel[] = []

    const addExecutable = async (method: "desktop" | "standalone", executable: string) => {
      if (!(await dependencies.exists(executable))) return
      const result = await dependencies.run([executable, "--version"])
      const version = result.exitCode === 0 ? parseVersion(result.stdout) : null
      installations.push({
        method,
        executable,
        version,
        status: version ? "ok" : "failed",
        current: sameExecutable(executable, realExecPath),
        pathFirst: firstPath ? sameExecutable(executable, firstPath) : false,
      })
    }

    const desktopExecutable = DesktopInstallation.isRuntimePath(context.platform, realExecPath)
      ? realExecPath
      : DesktopInstallation.expectedRuntimePath(context.platform)
    if (desktopExecutable) await addExecutable("desktop", desktopExecutable)

    const pathModule = context.platform === "win32" ? path.win32 : path
    const standaloneExecutable = pathModule.join(
      context.home,
      ".synergy",
      "bin",
      context.platform === "win32" ? "synergy.exe" : "synergy",
    )
    if (!desktopExecutable || !sameExecutable(desktopExecutable, standaloneExecutable)) {
      await addExecutable("standalone", standaloneExecutable)
    }

    const packageResults = await Promise.all(
      packageChecks.map(async (check) => ({ check, result: await dependencies.run(check.command) })),
    )
    for (const { check, result } of packageResults) {
      if (!check.marker.test(result.stdout)) continue
      const version = parsePackageVersion(check.method, result.stdout)
      installations.push({
        method: check.method,
        executable: null,
        version,
        status: version ? "ok" : "failed",
        current: false,
        pathFirst: false,
      })
    }

    const current = currentMethod(context, installations)
    for (const installation of installations) installation.current = installation.method === current
    const pathFirst = installations.find((installation) =>
      installation.executable && firstPath ? sameExecutable(installation.executable, firstPath) : false,
    )
    if (pathFirst) pathFirst.pathFirst = true
    else if (pathCandidates[0]?.isCurrent) {
      const active = installations.find((installation) => installation.method === current)
      if (active) active.pathFirst = true
    }

    return {
      current,
      conflict: installations.length > 1,
      installations,
      path: pathCandidates,
    }
  }

  export function resolveUpgradeMethod(inspection: Inspection, requested?: InstalledMethod): InstalledMethod {
    if (requested) {
      const selected = inspection.installations.find((installation) => installation.method === requested)
      if (!selected)
        throw new InstallationMethodNotFoundError({ method: requested, installations: inspection.installations })
      if (selected.status === "failed") throw new InstallationProbeFailedError({ method: requested })
      return requested
    }
    if (inspection.conflict) throw new MultipleInstallationsError({ installations: inspection.installations })
    const selected = inspection.installations.find((installation) => installation.method === inspection.current)
    if (!selected || inspection.current === "unknown") {
      throw new InstallationMethodNotFoundError({ method: inspection.current, installations: inspection.installations })
    }
    if (selected.status === "failed") throw new InstallationProbeFailedError({ method: selected.method })
    return selected.method
  }

  export function resolveRemovalMethod(inspection: Inspection, requested?: InstalledMethod): InstalledMethod {
    if (requested) {
      const selected = inspection.installations.find((installation) => installation.method === requested)
      if (!selected)
        throw new InstallationMethodNotFoundError({ method: requested, installations: inspection.installations })
      return requested
    }
    if (inspection.conflict) throw new MultipleInstallationsError({ installations: inspection.installations })
    const selected = inspection.installations.find((installation) => installation.method === inspection.current)
    if (!selected || inspection.current === "unknown") {
      throw new InstallationMethodNotFoundError({ method: inspection.current, installations: inspection.installations })
    }
    return selected.method
  }

  function currentMethod(context: InspectionContext, installations: InstalledChannel[]): Method {
    if (DesktopInstallation.isRuntimePath(context.platform, context.realExecPath)) return "desktop"
    if (StandaloneInstallation.detectStandaloneInstall(context)) return "standalone"
    const executable = context.execPath.toLowerCase()
    const packageMethods: InstalledMethod[] = ["npm", "yarn", "pnpm", "bun", "brew"]
    return (
      packageMethods.find(
        (method) => executable.includes(method) && installations.some((item) => item.method === method),
      ) ??
      packageMethods.find((method) => installations.some((item) => item.method === method)) ??
      "unknown"
    )
  }

  function parseVersion(output: string) {
    return output.trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0] ?? null
  }

  function parsePackageVersion(method: InstalledMethod, output: string) {
    if (method === "brew") return output.match(/(?:^|\s)synergy\s+([^\s]+)/m)?.[1] ?? null
    return (
      output.match(
        /@ericsanchezok\/synergy(?:@(?:npm:)?|\s+)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/,
      )?.[1] ?? null
    )
  }

  function sameExecutable(left: string, right: string) {
    return DesktopInstallation.normalizePath(left) === DesktopInstallation.normalizePath(right)
  }

  const defaultInspectionDependencies: InspectionDependencies = {
    exists: (candidate) =>
      fs.access(candidate).then(
        () => true,
        () => false,
      ),
    pathCandidates: (context) => DesktopInstallation.pathCandidates(context),
    async run(command) {
      try {
        const subprocess = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
        const timer = setTimeout(() => subprocess.kill(), 5_000)
        const [exitCode, stdout, stderr] = await Promise.all([
          subprocess.exited,
          new Response(subprocess.stdout).text(),
          new Response(subprocess.stderr).text(),
        ]).finally(() => clearTimeout(timer))
        return { exitCode, stdout, stderr }
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  export async function method(): Promise<Method> {
    const execPath = process.execPath
    const realExecPath = await fs.realpath(execPath).catch(() => execPath)
    if (DesktopInstallation.isRuntimePath(process.platform, realExecPath)) return "desktop"
    if (
      StandaloneInstallation.detectStandaloneInstall({
        platform: process.platform,
        execPath,
        realExecPath,
        env: process.env,
      })
    )
      return "standalone"

    const executable = execPath.toLowerCase()
    const checks = [...packageChecks].sort((left, right) => {
      const leftMatches = executable.includes(left.method)
      const rightMatches = executable.includes(right.method)
      if (leftMatches && !rightMatches) return -1
      if (!leftMatches && rightMatches) return 1
      return 0
    })
    for (const check of checks) {
      const result = await defaultInspectionDependencies.run(check.command)
      if (check.marker.test(result.stdout)) return check.method
    }
    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  export const DesktopManagedUpdateError = NamedError.create(
    "DesktopManagedUpdateError",
    z.object({
      message: z.string(),
    }),
  )

  async function getBrewFormula() {
    // Homebrew not supported for private repo
    return "synergy"
  }

  export async function upgrade(method: Method, target: string) {
    if (method === "standalone") {
      const [realExecPath, libc] = await Promise.all([
        fs.realpath(process.execPath).catch(() => process.execPath),
        StandaloneInstallation.detectLibc(process.platform),
      ])
      const result = await StandaloneInstallation.upgrade({
        target,
        context: {
          platform: process.platform,
          libc,
          execPath: process.execPath,
          realExecPath,
          env: process.env,
        },
      })
      log.info("upgraded", { method, target, stdout: result.stdout, stderr: result.stderr })
      await $`${process.execPath} --version`.nothrow().quiet().text()
      return
    }

    let cmd
    switch (method) {
      case "npm":
        cmd = $`npm install -g @ericsanchezok/synergy@${target} --registry=${NPM_REGISTRY}`
        break
      case "yarn":
        cmd = $`yarn global add @ericsanchezok/synergy@${target} --registry=${NPM_REGISTRY}`
        break
      case "pnpm":
        cmd = $`pnpm install -g @ericsanchezok/synergy@${target} --registry=${NPM_REGISTRY}`
        break
      case "bun":
        cmd = $`bun install -g @ericsanchezok/synergy@${target} --registry=${NPM_REGISTRY}`
        break
      case "brew": {
        const formula = await getBrewFormula()
        cmd = $`brew install ${formula}`.env({
          HOMEBREW_NO_AUTO_UPDATE: "1",
          ...process.env,
        })
        break
      }
      case "desktop":
        throw new DesktopManagedUpdateError({
          message:
            "Synergy is installed with the Desktop app. Desktop updates are managed from the Synergy app. Open Synergy and use Settings → Updates.",
        })
      default:
        throw new Error(`Unknown method: ${method}`)
    }
    const result = await cmd.quiet().throws(false)
    log.info("upgraded", {
      method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    if (result.exitCode !== 0)
      throw new UpgradeFailedError({
        stderr: result.stderr.toString("utf8"),
      })
    await $`${process.execPath} --version`.nothrow().quiet().text()
  }

  export const VERSION = typeof SYNERGY_VERSION === "string" ? SYNERGY_VERSION : "local"
  export const CHANNEL = typeof SYNERGY_CHANNEL === "string" ? SYNERGY_CHANNEL : "local"
  export const USER_AGENT = `synergy/${CHANNEL}/${VERSION}/${Flag.SYNERGY_CLIENT}`

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula === "synergy") {
        return fetch("https://formulae.brew.sh/api/formula/synergy.json")
          .then((res) => {
            if (!res.ok) throw new Error(res.statusText)
            return res.json()
          })
          .then((data: any) => data.versions.stable)
      }
    }

    if (
      detectedMethod === "npm" ||
      detectedMethod === "yarn" ||
      detectedMethod === "bun" ||
      detectedMethod === "pnpm"
    ) {
      const channel = npmDistTagForChannel(CHANNEL)
      return fetch(`${NPM_REGISTRY}/@ericsanchezok/synergy/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return fetch("https://api.github.com/repos/SII-Holos/synergy/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}

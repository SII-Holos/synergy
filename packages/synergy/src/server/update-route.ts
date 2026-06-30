import fs from "fs/promises"
import path from "path"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { DaemonState } from "../daemon/state"
import { DaemonPaths } from "../daemon/paths"
import { Installation } from "../global/installation"

const NPM_PACKAGE = "@ericsanchezok/synergy"
const NPM_REGISTRY = "https://registry.npmjs.org"

const ServerUpdateCapability = z.enum(["managed", "not-managed", "remote"])
const ServerUpdatePhase = z.enum(["idle", "checking", "available", "updating", "restarting", "error"])

const ServerUpdateStatus = z
  .object({
    capability: ServerUpdateCapability,
    phase: ServerUpdatePhase,
    currentVersion: z.string(),
    latestVersion: z.string().nullable(),
    updateAvailable: z.boolean(),
    progress: z.number().min(0).max(100).nullable(),
    message: z.string(),
    error: z.string().nullable(),
  })
  .meta({ ref: "ServerUpdateStatus" })
type ServerUpdateStatus = z.infer<typeof ServerUpdateStatus>

const ServerUpdateStartInput = z
  .object({
    version: z.string().optional(),
  })
  .optional()
  .meta({ ref: "ServerUpdateStartInput" })

const ServerUpdateForbiddenError = z.object({ message: z.string() }).meta({ ref: "ServerUpdateForbiddenError" })

export interface ServerUpdateWorkerControls {
  spawn(command: string[]): void
  latestVersion(): Promise<string>
  installMethod(): Promise<Installation.Method>
}

let workerControls: ServerUpdateWorkerControls = {
  spawn(command) {
    const subprocess = Bun.spawn(command, {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })
    ;(subprocess as any).unref?.()
  },
  latestVersion: fetchLatestVersion,
  installMethod: Installation.method,
}

export const UpdateRoute = new Hono()
  .get(
    "/status",
    describeRoute({
      summary: "Get server update status",
      description: "Report whether this Synergy server can be updated from the Web client.",
      operationId: "global.update.status",
      responses: {
        200: {
          description: "Server update status",
          content: { "application/json": { schema: resolver(ServerUpdateStatus) } },
        },
      },
    }),
    async (c) => c.json(await statusForRequest(c.req.url, c.req.header("host"), false)),
  )
  .post(
    "/check",
    describeRoute({
      summary: "Check for server updates",
      description: "Check npm for the latest Synergy server package version. Localhost-only.",
      operationId: "global.update.check",
      responses: {
        200: {
          description: "Server update status",
          content: { "application/json": { schema: resolver(ServerUpdateStatus) } },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ServerUpdateForbiddenError) } },
        },
      },
    }),
    async (c) => {
      if (!isLocalhost(c.req.url, c.req.header("host"))) {
        return c.json({ message: "Server update checks are restricted to localhost" }, 403)
      }
      return c.json(await statusForRequest(c.req.url, c.req.header("host"), true))
    },
  )
  .post(
    "/start",
    describeRoute({
      summary: "Start server update",
      description: "Start a detached updater worker for a managed Synergy daemon. Localhost-only.",
      operationId: "global.update.start",
      responses: {
        200: {
          description: "Server update status",
          content: { "application/json": { schema: resolver(ServerUpdateStatus) } },
        },
        400: {
          description: "Server update unavailable",
          content: { "application/json": { schema: resolver(ServerUpdateStatus) } },
        },
        403: {
          description: "Forbidden",
          content: { "application/json": { schema: resolver(ServerUpdateForbiddenError) } },
        },
      },
    }),
    validator("json", ServerUpdateStartInput),
    async (c) => {
      if (!isLocalhost(c.req.url, c.req.header("host"))) {
        return c.json({ message: "Server updates are restricted to localhost" }, 403)
      }
      const manifest = await managedManifest()
      if (!manifest) return c.json(notManagedStatus(), 400)
      const persisted = await readPersistedStatus().catch(() => null)
      if (persisted && isActivePhase(persisted.phase)) return c.json(persisted)
      const body = c.req.valid("json")
      const latestVersion = body?.version ?? (await workerControls.latestVersion())
      if (!isNewerVersion(latestVersion, Installation.VERSION)) {
        return c.json({
          ...managedStatus("idle", latestVersion, null, 100),
          updateAvailable: false,
          message: `Synergy ${Installation.VERSION} is current.`,
        })
      }
      const started = await startWorker(manifest, latestVersion)
      if (!started.ok) {
        return c.json(
          {
            ...managedStatus("error", latestVersion, started.error, null),
            message: started.error,
          },
          400,
        )
      }
      return c.json({
        ...managedStatus("updating", latestVersion, null),
        progress: 5,
        updateAvailable: true,
        message: `Updating Synergy service to ${latestVersion}.`,
      })
    },
  )

async function statusForRequest(url: string, host: string | undefined, check: boolean): Promise<ServerUpdateStatus> {
  if (!isLocalhost(url, host)) return remoteStatus()
  const manifest = await managedManifest()
  if (!manifest) return notManagedStatus()
  const persisted = await readPersistedStatus().catch(() => null)
  if (persisted && isActivePhase(persisted.phase)) return persisted
  if (persisted && !check && persisted.phase !== "idle") return persisted
  if (!check) return managedStatus("idle", null, null)
  try {
    const latest = await workerControls.latestVersion()
    const updateAvailable = isNewerVersion(latest, Installation.VERSION)
    const unsupportedInstallMethod =
      updateAvailable && !updateInstallCommand(await workerControls.installMethod(), latest)
    if (unsupportedInstallMethod) {
      const error = "Managed service install method cannot be updated from Web."
      return {
        ...managedStatus("error", latest, error, null),
        updateAvailable: true,
        message: error,
      }
    }
    return {
      ...managedStatus(updateAvailable ? "available" : "idle", latest, null, updateAvailable ? 0 : 100),
      updateAvailable,
      message: updateAvailable ? `Synergy ${latest} is available.` : `Synergy ${Installation.VERSION} is current.`,
    }
  } catch (error) {
    return managedStatus("error", null, error instanceof Error ? error.message : String(error), null)
  }
}

async function managedManifest() {
  if (process.env.SYNERGY_DAEMON !== "1") return null
  return await DaemonState.readManifest().catch(() => null)
}

function managedStatus(
  phase: z.infer<typeof ServerUpdatePhase>,
  latestVersion: string | null,
  error: string | null,
  progress: number | null = null,
) {
  return {
    capability: "managed" as const,
    phase,
    currentVersion: Installation.VERSION,
    latestVersion,
    updateAvailable: Boolean(latestVersion && isNewerVersion(latestVersion, Installation.VERSION)),
    progress,
    message: phase === "idle" ? "This Synergy service is managed locally." : "Synergy service update status.",
    error,
  }
}

function isActivePhase(phase: z.infer<typeof ServerUpdatePhase>) {
  return phase === "updating" || phase === "restarting"
}

function notManagedStatus(): ServerUpdateStatus {
  return {
    capability: "not-managed",
    phase: "idle",
    currentVersion: Installation.VERSION,
    latestVersion: null,
    updateAvailable: false,
    progress: null,
    message: "This server was not started as a Synergy managed service.",
    error: null,
  }
}

function remoteStatus(): ServerUpdateStatus {
  return {
    capability: "remote",
    phase: "idle",
    currentVersion: Installation.VERSION,
    latestVersion: null,
    updateAvailable: false,
    progress: null,
    message: "Server updates are only available from localhost.",
    error: null,
  }
}

async function fetchLatestVersion(): Promise<string> {
  return await Installation.latest()
}

async function startWorker(
  manifest: DaemonState.Manifest,
  version: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await DaemonState.ensureDirs()
  const workerPath = workerScriptPath()
  const statePath = updateStatePath()
  const logPath = path.join(DaemonPaths.logs(), "update.log")
  const controlCommand = resolveControlCommand(manifest.command)
  if (!controlCommand) {
    return { ok: false, error: "Managed service command cannot be safely updated from Web." }
  }
  const installCommand = updateInstallCommand(await workerControls.installMethod(), version)
  if (!installCommand) {
    return { ok: false, error: "Managed service install method cannot be updated from Web." }
  }

  await writePersistedStatus({
    ...managedStatus("updating", version, null, 5),
    message: `Updating Synergy service to ${version}.`,
  })
  await fs.writeFile(workerPath, renderWorkerScript({ controlCommand, installCommand, version, statePath, logPath }), {
    mode: 0o755,
  })
  workerControls.spawn(process.platform === "win32" ? ["cmd.exe", "/c", workerPath] : ["sh", workerPath])
  return { ok: true }
}

export function resolveControlCommand(command: string[]): string[] | undefined {
  const serverIndex = command.findIndex((part) => part === "server")
  if (serverIndex > 0) return command.slice(0, serverIndex)

  const first = command[0]
  if (!first) return
  const basename = path.win32.basename(first).toLowerCase()
  if (basename === "synergy" || basename === "synergy.exe") return [first]
  return
}

function updateInstallCommand(method: Installation.Method, version: string): string[] | undefined {
  const spec = `${NPM_PACKAGE}@${version}`
  if (method === "npm") return ["npm", "install", "-g", "--no-audit", "--no-fund", spec, `--registry=${NPM_REGISTRY}`]
  if (method === "pnpm") return ["pnpm", "install", "-g", spec, `--registry=${NPM_REGISTRY}`]
  if (method === "bun") return ["bun", "install", "-g", spec, `--registry=${NPM_REGISTRY}`]
  if (method === "yarn") return ["yarn", "global", "add", spec, `--registry=${NPM_REGISTRY}`]
  return
}

function renderWorkerScript(input: {
  controlCommand: string[]
  installCommand: string[]
  version: string
  statePath: string
  logPath: string
}) {
  if (process.platform === "win32") {
    const stop = windowsCommand([...input.controlCommand, "stop"])
    const start = windowsCommand([...input.controlCommand, "start"])
    const install = windowsCommand(input.installCommand)
    const preparing = stateJson("updating", input.version, 20, "Installing Synergy runtime.", null)
    const restarting = stateJson("restarting", input.version, 75, "Restarting Synergy service.", null)
    const done = stateJson("idle", input.version, 100, "Synergy service updated.", null)
    const failed = stateJson("error", input.version, null, "Synergy service update failed.", "Update worker failed.")
    return `@echo off
setlocal
echo Updating Synergy to ${input.version} > "${input.logPath}"
echo ${preparing} > "${input.statePath}"
${install} >> "${input.logPath}" 2>&1
if errorlevel 1 goto failed
echo ${restarting} > "${input.statePath}"
${stop} >> "${input.logPath}" 2>&1
if errorlevel 1 goto restore
${start} >> "${input.logPath}" 2>&1
if errorlevel 1 goto restore
echo ${done} > "${input.statePath}"
exit /b 0
:restore
${start} >> "${input.logPath}" 2>&1
:failed
echo ${failed} > "${input.statePath}"
exit /b 1
`
  }
  const stop = shellCommand([...input.controlCommand, "stop"])
  const start = shellCommand([...input.controlCommand, "start"])
  const install = shellCommand(input.installCommand)
  const failed = stateJson("error", input.version, null, "Synergy service update failed.", "Update worker failed.")
  return `#!/bin/sh
set -u
fail() {
  printf '%s\\n' '${failed}' > ${shellQuote(input.statePath)}
  exit 1
}
restore() {
  ${start} >> ${shellQuote(input.logPath)} 2>&1 || true
  fail
}
echo "Updating Synergy to ${shellQuote(input.version)}" > ${shellQuote(input.logPath)}
printf '%s\\n' '${stateJson("updating", input.version, 20, "Installing Synergy runtime.", null)}' > ${shellQuote(input.statePath)}
${install} >> ${shellQuote(input.logPath)} 2>&1 || fail
printf '%s\\n' '${stateJson("restarting", input.version, 75, "Restarting Synergy service.", null)}' > ${shellQuote(input.statePath)}
${stop} >> ${shellQuote(input.logPath)} 2>&1 || restore
${start} >> ${shellQuote(input.logPath)} 2>&1 || restore
printf '%s\\n' '${stateJson("idle", input.version, 100, "Synergy service updated.", null)}' > ${shellQuote(input.statePath)}
`
}

function stateJson(
  phase: z.infer<typeof ServerUpdatePhase>,
  version: string,
  progress: number | null,
  message: string,
  error: string | null,
) {
  return JSON.stringify({
    capability: "managed",
    phase,
    currentVersion: phase === "idle" ? version : Installation.VERSION,
    latestVersion: version,
    updateAvailable: phase !== "idle",
    progress,
    message,
    error,
  })
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function shellCommand(parts: string[]) {
  return parts.map(shellQuote).join(" ")
}

function windowsCommand(parts: string[]) {
  return parts.map((part) => `"${part.replaceAll(`"`, `""`)}"`).join(" ")
}

function workerScriptPath() {
  return path.join(DaemonPaths.root(), process.platform === "win32" ? "update-worker.cmd" : "update-worker.sh")
}

function updateStatePath() {
  return path.join(DaemonPaths.root(), "update-state.json")
}

async function readPersistedStatus(): Promise<ServerUpdateStatus | null> {
  const file = Bun.file(updateStatePath())
  if (!(await file.exists().catch(() => false))) return null
  const parsed = ServerUpdateStatus.safeParse(await file.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

async function writePersistedStatus(status: ServerUpdateStatus): Promise<void> {
  await fs.writeFile(updateStatePath(), JSON.stringify(ServerUpdateStatus.parse(status), null, 2) + "\n")
}

function isLocalhost(requestUrl: string, hostHeader: string | undefined) {
  const hostname = new URL(requestUrl).hostname
  const host = hostHeaderName(hostHeader)
  return isLocalhostName(hostname) && (!host || isLocalhostName(host))
}

function isLocalhostName(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

function hostHeaderName(hostHeader: string | undefined) {
  const value = hostHeader?.trim() ?? ""
  if (!value) return ""
  if (value.startsWith("[")) {
    const index = value.indexOf("]")
    return index === -1 ? value : value.slice(0, index + 1)
  }
  return value.split(":")[0] ?? value
}

function isNewerVersion(candidate: string, current: string) {
  const next = parseVersion(candidate)
  const prev = parseVersion(current)
  for (let i = 0; i < 3; i++) {
    if (next[i] > prev[i]) return true
    if (next[i] < prev[i]) return false
  }
  return false
}

function parseVersion(value: string) {
  return value
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number(part) || 0) as [number, number, number]
}

export function setServerUpdateWorkerControlsForTest(controls?: Partial<ServerUpdateWorkerControls>) {
  workerControls = {
    spawn(command) {
      const subprocess = Bun.spawn(command, {
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      })
      ;(subprocess as any).unref?.()
    },
    latestVersion: fetchLatestVersion,
    installMethod: Installation.method,
    ...controls,
  }
}

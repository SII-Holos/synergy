import { mkdir } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Log } from "@/util/log"
import { HolosLocalMeta } from "./local-meta"

const log = Log.create({ service: "holos.local-takeover" })

const CONTROL_TIMEOUT_MS = 500
const STOP_WAIT_MS = 1_500
const STOP_POLL_MS = 50

const OwnerRegistry = z.object({
  owner: z.literal("synergy"),
  agentId: z.string(),
  claimedAt: z.number(),
  pid: z.number().optional(),
  version: z.literal(1),
})

export namespace HolosLocalTakeover {
  export interface Paths {
    root: string
    controlSocketPath: string
    ownerRegistryPath: string
  }

  export interface Detection {
    controlAvailable: boolean
    ownerRegistryExists: boolean
    metaDetected: boolean
  }

  export interface Result {
    controlSocketPath: string
    ownerRegistryPath: string
    controlAvailable: boolean
    metaDetected: boolean
    handoff: "none" | "managed" | "stopped"
  }

  export function paths(): Paths {
    return HolosLocalMeta.paths()
  }

  export async function detect(input: Paths = paths()): Promise<Detection> {
    const ownerRegistryExists = await Bun.file(input.ownerRegistryPath).exists()
    const controlAvailable = await isControlAvailable(input.controlSocketPath)
    return {
      controlAvailable,
      ownerRegistryExists,
      metaDetected: controlAvailable || ownerRegistryExists,
    }
  }

  export async function claimOwner(agentId: string, ownerRegistryPath = paths().ownerRegistryPath): Promise<void> {
    await mkdir(path.dirname(ownerRegistryPath), { recursive: true })
    const payload = OwnerRegistry.parse({
      owner: "synergy",
      agentId,
      claimedAt: Date.now(),
      pid: typeof process.pid === "number" ? process.pid : undefined,
      version: 1,
    })
    await Bun.write(ownerRegistryPath, JSON.stringify(payload, null, 2) + "\n")
  }

  export async function takeover(agentId: string): Promise<Result> {
    const resolved = paths()
    const detection = await detect(resolved)
    await claimOwner(agentId, resolved.ownerRegistryPath)

    if (!detection.controlAvailable) {
      return {
        controlSocketPath: resolved.controlSocketPath,
        ownerRegistryPath: resolved.ownerRegistryPath,
        controlAvailable: false,
        metaDetected: detection.metaDetected,
        handoff: "none",
      }
    }

    const managed = await requestManagedMode(resolved.controlSocketPath, agentId)
    if (managed) {
      return {
        controlSocketPath: resolved.controlSocketPath,
        ownerRegistryPath: resolved.ownerRegistryPath,
        controlAvailable: true,
        metaDetected: true,
        handoff: "managed",
      }
    }

    const stopped = await stopService(resolved.controlSocketPath)
    if (!stopped) {
      throw new Error(
        `Local meta-synergy is active at ${resolved.controlSocketPath} but did not accept managed takeover`,
      )
    }

    await waitForControlToStop(resolved.controlSocketPath)

    log.info("managed mode unavailable, stopped local meta-synergy for Phase 1 takeover", {
      controlSocketPath: resolved.controlSocketPath,
    })

    return {
      controlSocketPath: resolved.controlSocketPath,
      ownerRegistryPath: resolved.ownerRegistryPath,
      controlAvailable: true,
      metaDetected: true,
      handoff: "stopped",
    }
  }
}

async function isControlAvailable(controlSocketPath: string): Promise<boolean> {
  return await HolosLocalMeta.isAvailable(controlSocketPath, CONTROL_TIMEOUT_MS)
}

async function requestManagedMode(controlSocketPath: string, agentId: string): Promise<boolean> {
  const requests = [
    {
      action: "runtime.enter_managed_mode",
      owner: "synergy",
      ownerAgentId: agentId,
      phase: 1,
    },
    {
      action: "runtime.set_mode",
      mode: "managed",
      owner: "synergy",
      ownerAgentId: agentId,
    },
  ]

  for (const payload of requests) {
    try {
      const response = await HolosLocalMeta.request(payload, {
        controlSocketPath,
        timeoutMs: CONTROL_TIMEOUT_MS,
      })
      if (response.ok) return true
      if (!isUnsupportedAction(response.error.message)) {
        log.warn("managed takeover request failed", {
          action: payload.action,
          code: response.error.code,
          message: response.error.message,
        })
      }
    } catch (error) {
      log.warn("managed takeover request transport failed", {
        action: payload.action,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return false
}

async function stopService(controlSocketPath: string): Promise<boolean> {
  try {
    const response = await HolosLocalMeta.request(
      { action: "service.stop" },
      { controlSocketPath, timeoutMs: CONTROL_TIMEOUT_MS },
    )
    return response.ok
  } catch (error) {
    log.warn("service.stop takeover fallback failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function waitForControlToStop(controlSocketPath: string): Promise<void> {
  const deadline = Date.now() + STOP_WAIT_MS
  while (Date.now() < deadline) {
    if (!(await isControlAvailable(controlSocketPath))) return
    await Bun.sleep(STOP_POLL_MS)
  }
}

function isUnsupportedAction(message: string): boolean {
  return message.includes("Unsupported control action") || message.includes("Invalid input")
}

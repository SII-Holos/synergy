import z from "zod"
import { Identifier } from "@/id/id"
import { StoragePath } from "@/storage/path"
import { Storage } from "@/storage/storage"
import type { Info } from "./types"
import { LightLoopTerminalStatus } from "./light-loop-state"

const PluginOwner = z.object({
  pluginId: z.string(),
  pluginGeneration: z.string(),
  scopeId: z.string(),
  correlationId: z.string().optional(),
})

export const LightLoopTerminalRecord = z.object({
  sessionID: Identifier.schema("session"),
  status: LightLoopTerminalStatus,
  instructions: z.string(),
  pluginOwner: PluginOwner,
  error: z.string().optional(),
  hookDeliveredAt: z.number().optional(),
  hookError: z.string().optional(),
  createdAt: z.number(),
})

export type LightLoopTerminalRecord = z.infer<typeof LightLoopTerminalRecord>

type SessionKey = Pick<Info, "id" | "scope">

function path(session: SessionKey) {
  return StoragePath.sessionLightLoopTerminal(
    Identifier.asScopeID(session.scope.id),
    Identifier.asSessionID(session.id),
  )
}

export namespace LightLoopTerminalStore {
  export async function get(session: SessionKey): Promise<LightLoopTerminalRecord | undefined> {
    const value = await Storage.read<unknown>(path(session)).catch(() => undefined)
    const parsed = LightLoopTerminalRecord.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  export async function put(session: SessionKey, record: LightLoopTerminalRecord): Promise<void> {
    await Storage.write(path(session), record)
  }

  export async function acknowledge(session: SessionKey): Promise<void> {
    await Storage.update<LightLoopTerminalRecord>(path(session), (draft) => {
      draft.hookDeliveredAt = Date.now()
      draft.hookError = undefined
    })
  }

  export async function recordHookError(session: SessionKey, error: string): Promise<void> {
    await Storage.update<LightLoopTerminalRecord>(path(session), (draft) => {
      draft.hookError = error
    })
  }
}

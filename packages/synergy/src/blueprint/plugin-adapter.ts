import type { BlueprintCreateInput, BlueprintLoopInfo, LightLoopEnableInput } from "@ericsanchezok/synergy-plugin"
import { NoteStore } from "../note"
import { Session } from "../session"
import { SessionWorkflowService } from "../session/workflow"
import { BlueprintLoopStore } from "./loop-store"
import { BlueprintLoopService } from "./service"
import type { Info } from "./types"

export const BlueprintPluginErrorCode = {
  NOTE_INVALID: "BLUEPRINT_NOTE_INVALID",
  SESSION_REQUIRED: "BLUEPRINT_SESSION_REQUIRED",
  NOT_FOUND: "BLUEPRINT_NOT_FOUND",
  NOT_PLUGIN_OWNED: "BLUEPRINT_NOT_PLUGIN_OWNED",
  OWNER_MISMATCH: "BLUEPRINT_OWNER_MISMATCH",
  LIGHTLOOP_SESSION_REQUIRED: "LIGHTLOOP_SESSION_REQUIRED",
} as const

function pluginAdapterError(code: string, message: string) {
  return Object.assign(new Error(message), { name: "BlueprintPluginError", code })
}

// Keep a public-contract boundary here so storage-only fields can be filtered if the schemas diverge.
function publicLoop(loop: Info): BlueprintLoopInfo {
  return loop
}

async function ownedLoop(input: {
  scopeId: string
  loopID: string
  pluginId: string
  pluginGeneration: string
}): Promise<Info> {
  const loop = await BlueprintLoopStore.get(input.scopeId, input.loopID).catch(() => {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_FOUND, `BlueprintLoop not found: ${input.loopID}`)
  })
  if (loop.source !== "plugin" || !loop.pluginOwner) {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOT_PLUGIN_OWNED, "BlueprintLoop is not plugin-owned")
  }
  if (loop.pluginOwner.pluginId !== input.pluginId || loop.pluginOwner.pluginGeneration !== input.pluginGeneration) {
    throw pluginAdapterError(
      BlueprintPluginErrorCode.OWNER_MISMATCH,
      "BlueprintLoop belongs to another plugin generation",
    )
  }
  return loop
}

export async function createBlueprintLoop(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  sessionId?: string
  request: BlueprintCreateInput
}): Promise<BlueprintLoopInfo> {
  const note = await NoteStore.get(input.scopeId, input.request.noteID).catch(() => undefined)
  if (!note || note.kind !== "blueprint") {
    throw pluginAdapterError(BlueprintPluginErrorCode.NOTE_INVALID, "Note must exist and be kind=blueprint")
  }
  const sessionID = input.request.sessionID ?? input.sessionId
  if (!sessionID) {
    throw pluginAdapterError(BlueprintPluginErrorCode.SESSION_REQUIRED, "blueprint.create requires sessionID")
  }
  return publicLoop(
    await BlueprintLoopService.create({
      noteID: note.id,
      noteVersion: note.version,
      title: note.title,
      description: note.blueprint?.description,
      sessionID,
      runMode: input.request.runMode,
      model: input.request.model,
      source: "plugin",
      pluginOwner: {
        pluginId: input.pluginId,
        pluginGeneration: input.pluginGeneration,
        scopeId: input.scopeId,
      },
    }),
  )
}

export async function startBlueprintLoop(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  loopID: string
}): Promise<BlueprintLoopInfo> {
  await ownedLoop(input)
  return publicLoop(await BlueprintLoopService.start(input.scopeId, input.loopID))
}

export async function getBlueprintLoop(input: { scopeId: string; loopID: string }): Promise<BlueprintLoopInfo> {
  return publicLoop(
    await BlueprintLoopStore.get(input.scopeId, input.loopID).catch(() => {
      throw pluginAdapterError(BlueprintPluginErrorCode.NOT_FOUND, `BlueprintLoop not found: ${input.loopID}`)
    }),
  )
}

export async function listBlueprintLoops(scopeId: string): Promise<BlueprintLoopInfo[]> {
  return BlueprintLoopStore.list(scopeId)
}

export async function cancelBlueprintLoop(input: {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  loopID: string
}): Promise<BlueprintLoopInfo> {
  await ownedLoop(input)
  return publicLoop(await BlueprintLoopStore.updateStatus(input.scopeId, input.loopID, { status: "cancelled" }))
}

export async function enableLightLoop(input: {
  scopeId: string
  sessionId?: string
  request: LightLoopEnableInput
}): Promise<void> {
  const sessionID = input.request.sessionID ?? input.sessionId
  if (!sessionID) {
    throw pluginAdapterError(BlueprintPluginErrorCode.LIGHTLOOP_SESSION_REQUIRED, "lightloop.enable requires sessionID")
  }
  const session = await Session.get(sessionID)
  if (session.scope.id !== input.scopeId) {
    throw new Error(`Session ${sessionID} does not belong to the active Scope.`)
  }
  await SessionWorkflowService.enableLightloop(sessionID, input.request.taskDescription)
}

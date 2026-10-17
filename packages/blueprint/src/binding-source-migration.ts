import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { BlueprintLoopSources } from "./blueprint/source"

type Owner = { scopeID: string; sessionID: string }
type Loop = {
  id: string
  scopeID: string
  sessionID: string
  auditSessionID?: string
  noteID?: string
  source: string
  created?: number
}
const controlSources = new Set([
  "blueprint_loop_start",
  "blueprint_loop_continuation",
  "blueprint_loop_completed",
  "blueprint_loop_rejected",
])
const controlTools = new Set(["blueprint_loop_stop", "blueprint_loop_approve", "blueprint_loop_reject"])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function loopRecord(key: string[], value: Record<string, unknown>): Loop | undefined {
  if (key.length !== 3 || key[0] !== "blueprint_loops" || value.id !== key[2] || typeof value.sessionID !== "string")
    return
  if (value.source !== undefined && typeof value.source !== "string") return
  return {
    id: key[2],
    scopeID: key[1],
    sessionID: value.sessionID,
    auditSessionID: typeof value.auditSessionID === "string" ? value.auditSessionID : undefined,
    noteID: typeof value.noteID === "string" ? value.noteID : undefined,
    source: typeof value.source === "string" ? value.source : "user",
    created: typeof record(value.time)?.created === "number" ? (record(value.time)!.created as number) : undefined,
  }
}

async function readLoop(owner: Owner, id: unknown): Promise<Loop | undefined> {
  if (typeof id !== "string" || !id || /[\\/\0]/.test(id)) return
  const key = ["blueprint_loops", owner.scopeID, id]
  const [value] = await Storage.readMany<Record<string, unknown>>([key])
  const loop = value && loopRecord(key, value)
  return loop && [loop.sessionID, loop.auditSessionID].includes(owner.sessionID) ? loop : undefined
}

async function sessionBinding(owner: Owner, loop: Loop) {
  const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
  const [info] = await Storage.readMany<Record<string, unknown>>([key])
  const binding = record(info?.blueprint)
  if (!info || binding?.loopID !== loop.id || binding.source === loop.source) return
  binding.source = loop.source
  await Storage.write(key, info)
}

async function noteBinding(loop: Loop) {
  if (!loop.noteID) return
  const scopes = [...new Set([loop.scopeID, "home", ...(await Storage.scan(["notes"]))])]
  for (const scopeID of scopes) {
    const key = ["notes", scopeID, loop.noteID]
    const [note] = await Storage.readMany<Record<string, unknown>>([key])
    if (!note) continue
    const blueprint = record(note.blueprint)
    if (note.kind !== "blueprint" || !blueprint) return
    let changed = false
    if (blueprint.activeLoopID === loop.id && blueprint.activeLoopSource !== loop.source) {
      blueprint.activeLoopSource = loop.source
      changed = true
    }
    if (loop.created !== undefined && blueprint.lastRunAt === loop.created && blueprint.lastRunSource !== loop.source) {
      blueprint.lastRunSource = loop.source
      changed = true
    }
    if (changed) {
      await Storage.write(key, note)
      await Storage.remove(["notes", scopeID, "_index"])
    }
    return
  }
}

function requirements(metadata: Record<string, unknown>, loop: Loop) {
  if (!["user", "lattice", "plugin"].includes(loop.source)) return false
  let changed = false
  for (const [key, required] of [
    ["requiredFeatures", BlueprintLoopSources.requiredFeatures(loop.source)],
    ["requiredOwners", BlueprintLoopSources.requiredOwners(loop.source)],
  ] as const) {
    const existing = metadata[key]
    if (existing !== undefined && !Array.isArray(existing)) continue
    const next = [...new Set([...(existing ?? []), ...required])]
    if (JSON.stringify(existing) === JSON.stringify(next)) continue
    metadata[key] = next
    changed = true
  }
  return changed
}

async function refreshMessage(owner: Owner, message: Record<string, unknown>) {
  if (typeof message.id !== "string") return
  const key = StoragePath.sessionDisplayMessage(owner.scopeID, owner.sessionID, message.id)
  const [display] = await Storage.readMany<Record<string, unknown>>([key])
  if (display) await Storage.write(key, { ...display, ...SessionHistory.summarizeMessage(message as MessageV2.Info) })
}

async function refreshPart(owner: Owner, part: Record<string, unknown>) {
  if (part.sessionID !== owner.sessionID || typeof part.messageID !== "string" || typeof part.id !== "string") return
  await SessionHistory.refreshDisplayPart(owner.scopeID, part as MessageV2.ToolPart)
}

function toolLoopID(part: Record<string, unknown>, state: Record<string, unknown>) {
  const explicit = record(state.metadata)?.loopID
  if (typeof explicit === "string") return explicit
  if (part.tool !== "blueprint_loop_stop" || typeof state.output !== "string") return
  try {
    return record(record(JSON.parse(state.output))?.loop)?.id
  } catch {
    return
  }
}

async function upgradeBinding(owner: Owner) {
  const [info] = await Storage.readMany<Record<string, unknown>>([["sessions", owner.scopeID, owner.sessionID, "info"]])
  if (!info) return
  const loop = await readLoop(owner, record(info.blueprint)?.loopID)
  if (loop) {
    await sessionBinding(owner, loop)
    await noteBinding(loop)
  }
}

async function upgradeControls(owner: Owner) {
  for (const kind of ["message", "part", "inbox"]) {
    for await (const { key, value } of Storage.records<Record<string, unknown>>({
      kind,
      scopeID: owner.scopeID,
      sessionID: owner.sessionID,
    })) {
      if (kind === "part") {
        if (value.type !== "tool" || typeof value.tool !== "string" || !controlTools.has(value.tool)) continue
        const state = record(value.state)
        if (!state) continue
        const confirmed = await readLoop(owner, toolLoopID(value, state))
        if (!confirmed) continue
        const metadata = record(state.metadata) ?? (state.metadata === undefined ? {} : undefined)
        if (!metadata || !requirements(metadata, confirmed)) continue
        state.metadata = metadata
        await Storage.write(key, value)
        await refreshPart(owner, value)
        continue
      }
      const message = kind === "inbox" ? record(value.message) : value
      const metadata = record(message?.metadata)
      if (!metadata || typeof metadata.source !== "string" || !controlSources.has(metadata.source)) continue
      const confirmed = await readLoop(owner, metadata.loopID)
      if (!confirmed || !requirements(metadata, confirmed)) continue
      await Storage.write(key, value)
      if (kind === "message") await refreshMessage(owner, value)
    }
  }
}

export const bindingSourceMigration: Migration = {
  id: "20261012-blueprint-binding-sources",
  description: "Derive public Blueprint binding sources from their retained loop records",
  scope: "global",
  execution: "startup",
  dependsOn: [
    "blueprint_loop/20261012-blueprint-home-scope",
    "blueprint_loop/20260715-blueprint-loop-source-plugin",
    "blueprint-note/20261012-blueprint-note-owner",
  ],
  async up(progress) {
    let count = 0
    for await (const { key, value } of Storage.records<Record<string, unknown>>({ kind: "blueprint_loops" })) {
      const loop = loopRecord(key, value)
      if (!loop) continue
      await Storage.transaction(async () => {
        for (const sessionID of new Set([loop.sessionID, loop.auditSessionID].filter((id): id is string => !!id)))
          await sessionBinding({ scopeID: loop.scopeID, sessionID }, loop)
        await noteBinding(loop)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}

export const controlSourceMigration: Migration = {
  id: "20261012-blueprint-control-sources",
  description: "Attribute retained Blueprint bindings and control records to their actual loop owner",
  scope: "session",
  execution: "session",
  async upSession(owner) {
    await Storage.transaction(() => upgradeControls(owner))
  },
  async up(progress) {
    let count = 0
    for await (const { key } of Storage.records({ kind: "session" })) {
      await Storage.transaction(() => upgradeControls({ scopeID: key[1], sessionID: key[2] }))
      progress(++count, 0)
    }
    progress(count, count)
  },
}

export const bindingSourceAccessMigration: Migration = {
  id: "20261012-blueprint-session-binding-source",
  description: "Derive a retained Session binding source without reading its history",
  scope: "session",
  execution: "session",
  onAccess: (session) => typeof record(session.blueprint)?.loopID === "string",
  async upSession(owner) {
    await Storage.transaction(() => upgradeBinding(owner))
  },
  async up(progress) {
    let count = 0
    for await (const { key } of Storage.records({ kind: "session" })) {
      await Storage.transaction(() => upgradeBinding({ scopeID: key[1], sessionID: key[2] }))
      progress(++count, 0)
    }
    progress(count, count)
  },
}

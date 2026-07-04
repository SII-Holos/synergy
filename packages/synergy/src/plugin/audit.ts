import path from "path"
import fs from "fs/promises"
import { Global } from "../global/index.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditEventType =
  | "install_requested"
  | "install_approved"
  | "install_blocked"
  | "update_requested"
  | "update_approved"
  | "update_blocked"
  | "update_failed_rolled_back"
  | "capability_denied"
  | "plugin_disabled"
  | "runtime_started"
  | "runtime_killed"
  | "runtime_crashed"

export interface PluginAuditEvent {
  id: string
  pluginId: string
  time: number
  type: AuditEventType
  details: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

function auditPath(): string {
  return path.join(Global.Path.data, "plugin-audit.json")
}

// ---------------------------------------------------------------------------
// JSON read / write helpers
// ---------------------------------------------------------------------------

async function readAll(): Promise<PluginAuditEvent[]> {
  try {
    const text = await Bun.file(auditPath()).text()
    return JSON.parse(text)
  } catch {
    return []
  }
}

async function writeAll(events: PluginAuditEvent[]): Promise<void> {
  const p = auditPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await Bun.write(p, JSON.stringify(events, null, 2))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function recordEvent(event: Omit<PluginAuditEvent, "id" | "time">): Promise<void> {
  const full: PluginAuditEvent = {
    ...event,
    id: crypto.randomUUID(),
    time: Date.now(),
  }
  const events = await readAll()
  events.push(full)
  await writeAll(events)
}

export async function getEvents(pluginId?: string, limit?: number): Promise<PluginAuditEvent[]> {
  const events = await readAll()
  const filtered = pluginId ? events.filter((e) => e.pluginId === pluginId) : events
  if (limit != null && limit > 0) {
    return filtered.slice(-limit)
  }
  return filtered
}

export async function getRecentEvents(limit?: number): Promise<PluginAuditEvent[]> {
  return getEvents(undefined, limit)
}

import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

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

export async function recordEvent(event: Omit<PluginAuditEvent, "id" | "time">): Promise<void> {
  const full: PluginAuditEvent = {
    ...event,
    id: crypto.randomUUID(),
    time: Date.now(),
  }
  await Storage.write(["plugin-audit", "events", `${String(full.time).padStart(16, "0")}_${full.id}`], full)
}

export async function getEvents(pluginId?: string, limit?: number): Promise<PluginAuditEvent[]> {
  const events: PluginAuditEvent[] = []
  const bounded = limit !== undefined && limit > 0
  for await (const record of Storage.records<PluginAuditEvent>({
    kind: "plugin-audit",
    descending: bounded,
    limit: 128,
  })) {
    if (record.key[1] !== "events" || (pluginId && record.value.pluginId !== pluginId)) continue
    events.push(record.value)
    if (bounded && events.length >= limit) break
  }
  return bounded ? events.reverse() : events
}

export async function getRecentEvents(limit?: number): Promise<PluginAuditEvent[]> {
  return getEvents(undefined, limit)
}

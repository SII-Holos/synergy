import { riskForCapabilities } from "../capability"
import type { PermissionItem } from "./schema"

const labels: Record<string, { title: string; description: string; category: PermissionItem["category"] }> = {
  "session.read": {
    title: "Read sessions",
    description: "Read session metadata and content in the active Scope.",
    category: "session",
  },
  "session.control": {
    title: "Control sessions",
    description: "Abort or control sessions in the active Scope.",
    category: "session",
  },
  "task.delegate": {
    title: "Run delegated tasks",
    description: "Start Synergy tasks from plugin tools invoked by an agent.",
    category: "tools",
  },
  "blueprint.delegate": {
    title: "Run Blueprint workflows",
    description: "Create and control BlueprintLoop executions in the active Scope.",
    category: "tools",
  },
  "lightloop.delegate": {
    title: "Enable Light Loop",
    description: "Enable the Light Loop workflow in an existing Session.",
    category: "tools",
  },
  "workspace.read": {
    title: "Read workspace",
    description: "Read files inside the active Scope workspace.",
    category: "files",
  },
  "workspace.write": {
    title: "Write workspace",
    description: "Write files inside the active Scope workspace.",
    category: "files",
  },
  "settings.read": {
    title: "Read plugin settings",
    description: "Read this plugin's declarative settings.",
    category: "data",
  },
  "settings.write": {
    title: "Change plugin settings",
    description: "Change this plugin's declarative settings.",
    category: "data",
  },
  secrets: {
    title: "Access plugin secrets",
    description: "Read and update credentials stored for this plugin.",
    category: "identity",
  },
  "tool.invoke": {
    title: "Invoke Synergy tools",
    description: "Invoke tools visible to the current session.",
    category: "tools",
  },
  "ui.hostActions": {
    title: "Use host navigation",
    description: "Open Synergy sessions, panels, and resources from plugin UI.",
    category: "ui",
  },
  "composer.read": {
    title: "Read composer drafts",
    description: "Read settled text and selection from the active Synergy composer.",
    category: "ui",
  },
  "composer.write": {
    title: "Change composer drafts",
    description: "Offer completions and annotations or apply edits to the active composer.",
    category: "ui",
  },
  "composer.intercept": {
    title: "Intercept message submission",
    description: "Delay a normal message before it enters a Session while the plugin finishes its interaction.",
    category: "ui",
  },
  "selection.read": {
    title: "Read selected text",
    description: "Receive non-sensitive text selected in Synergy and add text actions to its menu.",
    category: "ui",
  },
  "agent.call": {
    title: "Call Synergy agents",
    description: "Send bounded text to approved Sessionless Agents without tools or Session history.",
    category: "tools",
  },
}

export function generatePermissionItems(capabilities: string[]): PermissionItem[] {
  return [...new Set(capabilities)].sort().map((key) => {
    const label = labels[key] ?? {
      title: key,
      description: `Use the Synergy host capability ${key}.`,
      category: "platform" as const,
    }
    return { key, ...label, severity: riskForCapabilities([key]) }
  })
}

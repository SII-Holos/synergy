import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
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
  "task.run": {
    title: "Run delegated tasks",
    description: "Start Synergy tasks from plugin operations or tools.",
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
}

export function generatePermissionItems(_manifest: PluginManifest, capabilities: string[]): PermissionItem[] {
  return [...new Set(capabilities)].sort().map((key) => {
    const label = labels[key] ?? {
      title: key,
      description: `Use the Synergy host capability ${key}.`,
      category: "platform" as const,
    }
    return { key, ...label, severity: riskForCapabilities([key]) }
  })
}

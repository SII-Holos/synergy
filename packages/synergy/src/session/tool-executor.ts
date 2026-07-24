import type { Tool } from "@/tool/tool"
import type { ToolExecutorKind } from "./tool-scheduler"

const processTools = new Set(["bash"])
const fileTools = new Set([
  "read",
  "view_file",
  "view_image",
  "write",
  "edit",
  "save_file",
  "revise_file",
  "grep",
  "glob",
  "file_search",
  "ls",
  "scan_files",
  "scan_document",
  "parse_code",
  "ast_grep",
  "lsp",
])

export namespace ToolExecutor {
  export function classify(toolName: string, source?: Tool.Source): ToolExecutorKind {
    if (source?.type === "plugin" || source?.type === "local" || toolName.startsWith("plugin__")) return "plugin"
    if (toolName.startsWith("browser_")) return "browser"
    if (toolName.startsWith("link_") || toolName.startsWith("remote_")) return "link"
    if (processTools.has(toolName)) return "local_process"
    if (fileTools.has(toolName)) return "file"
    return "control_plane"
  }
}

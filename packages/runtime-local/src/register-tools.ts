import { registerToolGroup } from "./tool-group-worktree"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { BashTool } from "./tools/bash"
import { EditTool } from "./tools/edit"
import { GlobTool } from "./tools/glob"
import { GrepTool } from "./tools/grep"
import { FileSearchTool } from "./tools/file-search"
import { ReadTool } from "./tools/read"
import { ViewFileTool } from "./tools/view-file"
import { ViewImageTool } from "./tools/view-image"
import { ReviseFileTool } from "./tools/revise-file"
import { ResolveConflictsTool } from "./tools/resolve-conflicts"
import { SaveFileTool } from "./tools/save-file"
import { ScanFilesTool } from "./tools/scan-files"
import { TodoWriteTool, TodoReadTool } from "./tools/todo"
import { DagWriteTool, DagReadTool, DagPatchTool } from "./tools/dag"
import { WebFetchTool } from "./tools/webfetch"
import { WriteTool } from "./tools/write"
import { SessionListTool } from "./tools/session-list"
import { SessionReadTool } from "./tools/session-read"
import { SessionSearchTool } from "./tools/session-search"
import { SessionSendTool } from "./tools/session-send"
import { ScopeListTool } from "./tools/scope-list"
import { AttachTool } from "./tools/attach"
import { SkillTool } from "./tools/skill"
import { ProcessTool } from "./tools/process"
import { RuntimeReloadTool } from "./tools/runtime-reload"

export function registerLocalTools() {
  registerToolGroup()
  ToolRegistry.registerToolProvider("runtime-local", () => {
    const tools = [
      BashTool,
      EditTool,
      GlobTool,
      GrepTool,
      FileSearchTool,
      ReadTool,
      ViewFileTool,
      ViewImageTool,
      ReviseFileTool,
      ResolveConflictsTool,
      SaveFileTool,
      ScanFilesTool,
      TodoWriteTool,
      TodoReadTool,
      DagWriteTool,
      DagReadTool,
      DagPatchTool,
      WebFetchTool,
      WriteTool,
      SessionListTool,
      SessionReadTool,
      SessionSearchTool,
      SessionSendTool,
      ScopeListTool,
      AttachTool,
      SkillTool,
      ProcessTool,
      RuntimeReloadTool,
    ]
    return tools
  })
}

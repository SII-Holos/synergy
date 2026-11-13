import { ToolPolicySource } from "@ericsanchezok/synergy-harness/tool/policy-source"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { OrganizationSessionProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import type { RuntimeIdentity } from "./home"
import { denied } from "./execution-source"

const nativeTools = [
  "search_tools",
  "expand_tools",
  "bash",
  "edit",
  "apply_patch",
  "file_search",
  "read",
  "view_file",
  "view_image",
  "revise_file",
  "resolve_conflicts",
  "save_file",
  "scan_files",
  "todowrite",
  "todoread",
  "dagwrite",
  "dagread",
  "dagpatch",
  "webfetch",
  "write",
  "session_read",
  "skill",
  "question",
  "task",
  "task_list",
  "task_output",
  "task_cancel",
  "organization_connection",
  "organization_mcp",
  "organization_knowledge",
] as const

const desktopTools = [
  "browser_annotate",
  "browser_snapshot",
  "browser_screenshot",
  "browser_inspect",
  "browser_wait",
  "browser_console",
  "browser_network",
  "browser_downloads",
  "browser_read",
  "browser_clipboard",
  "browser_navigation",
  "browser_assets",
  "browser_action",
  "browser_eval",
  "browser_performance",
  "browser_audit",
  "browser_emulate",
  "browser_dialog",
  "browser_upload",
] as const

export function registerOrganizationToolPolicy(identity: RuntimeIdentity) {
  const allowed = new Set<string>([...nativeTools, ...("accountID" in identity ? desktopTools : [])])
  const owns = (session?: Session.Info) => {
    const binding = Protocol.Binding.safeParse(session?.organization)
    return binding.success && binding.data.orgID === identity.orgID && session?.scope.id === binding.data.projectID
  }
  ToolPolicySource.register({
    async select(input) {
      return owns(input.session) ? input.toolIDs.filter((id) => allowed.has(id)) : []
    },
    async authorize(input) {
      input.signal?.throwIfAborted()
      if (!allowed.has(input.toolID) || !owns(await Session.get(input.sessionID)))
        throw denied("This tool is unavailable in the selected organization composition")
      input.signal?.throwIfAborted()
    },
  })
}

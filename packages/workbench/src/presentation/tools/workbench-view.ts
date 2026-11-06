import { createHash } from "node:crypto"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { FileView } from "@ericsanchezok/synergy-local-runtime/file/view"
import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
import { WorkbenchPresentation } from "../service"

export const WorkbenchViewTool = Tool.define(
  "workbench_view",
  {
    description:
      "Show an existing note, Workspace file, Browser page or immutable asset in a frontend actively viewing this Session; hide a returned viewId or inspect views. This only presents existing resources: it does not create resources, navigate Browser pages or perform arbitrary UI actions. With multiple eligible frontends, choose a returned clientId. Applied means the frontend confirmed presentation, not that loading content is ready. Waits 30 seconds for a receipt by default; timeout, disconnection or cancellation after dispatch may leave the effect unknown. Use status with the returned requestId to read the retained runtime receipt without replay. Reconnecting and conversation history never replay commands.",
    parameters: WorkbenchView.Parameters,
    resourceNeeds(args) {
      const parsed = WorkbenchView.Parameters.safeParse(args)
      return {
        workspace:
          parsed.success && parsed.data.input.action === "open" && parsed.data.input.target.kind === "workspace-file",
      }
    },
    async execute(parameters, ctx) {
      const scopeID = ScopeContext.current.scope.id
      const requestId =
        ctx.messageID && ctx.callID
          ? `wvr_${createHash("sha256")
              .update(JSON.stringify([scopeID, ctx.sessionID, ctx.messageID, ctx.callID]))
              .digest("hex")}`
          : `wvr_${crypto.randomUUID()}`
      let context: ResourceReference.Context | undefined
      if (parameters.input.action === "open" && parameters.input.target.kind === "workspace-file") {
        const session = await Session.get(ctx.sessionID)
        const selected = ctx.resources?.workspace
        if (
          session.scope.id === scopeID &&
          selected?.scopeID === scopeID &&
          selected.id === session.workspaceID &&
          (!session.workspace || selected.binding.generation === session.workspace.generation)
        )
          context = ResourceReference.capture({
            id: selected.id,
            generation: selected.binding.generation,
            path: ctx.resources?.directory ?? selected.binding.path ?? "",
          })
        context ??= { state: "none" }
        if (context.state === "bound") {
          const relative = ResourceReference.resolvePath(parameters.input.target.path, context)
          if (relative)
            await ctx.ask({
              permission: "read",
              patterns: [FileView.resolve(relative, context.workspace.root)],
              metadata: {},
            })
        }
      }
      const result = await WorkbenchPresentation.request(parameters, {
        scopeID,
        sessionID: ctx.sessionID,
        requestId,
        context,
        signal: ctx.abort,
      })
      return { title: `Workbench: ${result.status}`, metadata: { ...result }, output: JSON.stringify(result) }
    },
  },
  {
    requiresWorkspace: false,
    exposure: {
      mode: "search",
      title: "Workbench view",
      keywords: ["show", "open", "preview", "note", "file", "asset", "browser", "panel"],
    },
  },
)

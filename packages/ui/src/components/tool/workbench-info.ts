import { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
import { TOOL_TITLE_DESC } from "../tool-title-descriptors"
import { getToolIcon } from "./icons"

export function getWorkbenchViewInfo(input: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  const parsed = WorkbenchView.Command.safeParse(input.input)
  const command = parsed.success ? parsed.data : undefined
  let subtitle = ""
  if (command?.action === "open") {
    const target = command.target
    subtitle =
      target.kind === "note"
        ? target.id
        : target.kind === "workspace-file"
          ? target.path
          : target.kind === "browser-page"
            ? target.pageId
            : target.url
  } else if (command?.action === "hide") subtitle = command.viewId
  else if (command?.action === "status") subtitle = command.requestId ?? ""
  const args: string[] = []
  if (command) args.push(command.action)
  if (typeof metadata.status === "string") args.push(metadata.status)
  return { icon: getToolIcon("workbench_view", input, metadata), title: TOOL_TITLE_DESC.workbench_view, subtitle, args }
}

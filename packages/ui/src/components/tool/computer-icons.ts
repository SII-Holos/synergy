import { getToolIcon } from "./icons"

export const COMPUTER_TOOL_ICONS: Record<string, import("../icon").IconSource> = Object.fromEntries(
  ["computer_apps", "computer_observe", "computer_action"].map((tool) => [tool, getToolIcon(tool)]),
)

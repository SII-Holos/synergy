import { SessionInputTools } from "@ericsanchezok/synergy-harness/session/input-tools"
import { ReadTool } from "./tools/read"
import { ListTool } from "./tools/ls"

export function registerInputTools() {
  SessionInputTools.register({ read: ReadTool, list: ListTool })
}

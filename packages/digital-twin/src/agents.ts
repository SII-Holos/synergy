import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import prompt from "./prompts/predict.txt"

export function registerAgents() {
  AgentBuiltins.register("digital-twin", () => ({
    "digital-twin": {
      name: "digital-twin",
      mode: "primary",
      native: true,
      hidden: true,
      options: {},
      permission: PermissionNext.fromConfig({ "*": "deny" }),
      prompt,
    },
  }))
}

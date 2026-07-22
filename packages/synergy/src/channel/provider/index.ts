import { Channel } from ".."
import { FeishuProvider } from "./feishu"
import { ClarusProvider } from "./clarus"
import { registerClarusAssignmentLifecycle } from "./clarus/assignment-lifecycle"

let registered = false

export function registerProviders(): void {
  if (registered) return
  registered = true
  registerClarusAssignmentLifecycle()
  Channel.registerProvider(new FeishuProvider())
  Channel.registerProvider(new ClarusProvider())
}

import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Channel } from ".."
import { FeishuProvider } from "./feishu"
import { ClarusProvider } from "./clarus"
import { GithubProvider } from "./github"
import { registerClarusAssignmentLifecycle } from "./clarus/assignment-lifecycle"

const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerProviders(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true
  registerClarusAssignmentLifecycle()
  Channel.registerProvider(new FeishuProvider())
  Channel.registerProvider(new ClarusProvider())
  Channel.registerProvider(new GithubProvider())
}

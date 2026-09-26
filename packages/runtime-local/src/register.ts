import { registerHarness } from "@ericsanchezok/synergy-harness/lifecycle"
import { registerPolicyWorkerEntrypoint } from "@ericsanchezok/synergy-harness/enforcement/policy-worker/process-host"
import { Command } from "./command/command"
import { registerLocalSandboxHelper } from "./register-helper"
import { registerLocalNativeRuntime } from "./register-native"
import { registerAgentWorkerEntrypoint } from "@ericsanchezok/synergy-harness/session/agent-turn/process-host"
import { registerLocalProviderSdks } from "./provider/sdk-registry"
import { registerLocalTools } from "./register-tools"
import { registerInputTools } from "./register-input-tools"
import { registerWorkspace } from "./register-workspace"
import { registerSkillDomain } from "./skill/register"
import { registerCommandDomain } from "./command/register"
import { registerCommandStartup } from "./command/startup"
import { registerCommandSessionRuntime } from "./command/session-runtime"
import { registerQuestionTools } from "./question/tools"
import { registerQuestionSessionErrors } from "./question/session-errors"
import { registerCortexTools } from "@ericsanchezok/synergy-harness/cortex/tools"
import { registerCortexSessionRuntime } from "@ericsanchezok/synergy-harness/cortex/session-runtime"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerConfig } from "./config-schema"

const registration = RuntimeContext.state(() => ({ complete: false }))

export function registerLocalRuntime() {
  const state = registration()
  if (state.complete) return
  registerHarness()
  registerConfig()
  registerLocalSandboxHelper()
  registerLocalNativeRuntime()
  registerLocalProviderSdks()
  registerAgentWorkerEntrypoint(new URL("./agent-worker.ts", import.meta.url))
  registerPolicyWorkerEntrypoint(new URL("./policy-worker.ts", import.meta.url))
  registerLocalTools()
  registerInputTools()
  registerWorkspace()
  registerSkillDomain()
  registerCommandDomain()
  Command.registerActions()
  registerCommandStartup()
  registerCommandSessionRuntime()
  registerQuestionTools()
  registerQuestionSessionErrors()
  registerCortexTools()
  registerCortexSessionRuntime()
  state.complete = true
}

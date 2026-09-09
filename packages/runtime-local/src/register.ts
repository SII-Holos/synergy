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

export function registerLocalRuntime() {
  registerLocalSandboxHelper()
  registerLocalNativeRuntime()
  registerLocalProviderSdks()
  registerAgentWorkerEntrypoint(new URL("./agent-worker.ts", import.meta.url))
  registerLocalTools()
  registerInputTools()
  registerWorkspace()
  registerSkillDomain()
  registerCommandDomain()
  registerCommandStartup()
  registerCommandSessionRuntime()
  registerQuestionTools()
  registerQuestionSessionErrors()
  registerCortexTools()
  registerCortexSessionRuntime()
}

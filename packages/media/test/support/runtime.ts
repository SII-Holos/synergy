import { registerDocumentExtraction } from "../../src/register-documents"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { registerConfig } from "../../src/config-schema"
import { registerMediaAgents } from "../../src/agents"
import { registerMediaTools } from "../../src/register-tools"

export function testRuntime(env?: Record<string, string | undefined>) {
  return harnessRuntime({
    env,
    composition: {
      register() {
        registerLocalRuntime()
        registerConfig()
        registerDocumentExtraction()
        registerMediaAgents()
        registerMediaTools()
      },
    },
  })
}

import { ContinuationKernel } from "../session/continuation-kernel"
import { WorkflowPromptRegistry } from "../session/workflow-prompt-registry"
import { ToolRegistry } from "../tool/registry"
import { registerPluginBlueprintAdapter } from "../plugin/host-services"
import { BlueprintContinuationPolicy } from "./continuation"
import { BlueprintLoopRuntime } from "./loop-runtime"
import { cancelBlueprint, getBlueprint, startBlueprint } from "./plugin-adapter"
import { BlueprintLoopStopTool } from "./tools/blueprint-loop-stop"
import { BlueprintLoopApproveTool } from "./tools/blueprint-loop-approve"
import { BlueprintLoopRejectTool } from "./tools/blueprint-loop-reject"

/**
 * Blueprint domain registration (H1 continuation provider + control-source
 * contribution with the plugin-timer reattach hook + domain tools + the
 * protocol-5 host adapter slot). Loaded through src/product-registration.ts.
 */
let registered = false

export function registerBlueprintDomain(): void {
  if (registered) return
  registered = true

  ContinuationKernel.registerProvider("blueprint", () => [BlueprintContinuationPolicy])

  // "blueprint" is not a workflow kind: BlueprintLoop sessions carry
  // session.blueprint instead of session.workflow. The contribution exists
  // for the control-source suppression set and the plugin-reload timer
  // reattach fan-out; buildSystem is never kind-matched for it.
  WorkflowPromptRegistry.register({
    kind: "blueprint",
    controlSources: ["blueprint_loop_start", "blueprint_loop_continuation", "blueprint_loop_rejected"],
    reattachPluginTimers() {
      return BlueprintLoopRuntime.reattachPluginTimers()
    },
  })

  ToolRegistry.registerToolProvider("blueprint", () => [
    BlueprintLoopStopTool,
    BlueprintLoopApproveTool,
    BlueprintLoopRejectTool,
  ])

  registerPluginBlueprintAdapter({
    start: startBlueprint,
    get: getBlueprint,
    cancel: cancelBlueprint,
  })
}

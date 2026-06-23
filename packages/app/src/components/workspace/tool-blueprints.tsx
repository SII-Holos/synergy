import { BlueprintPanel } from "@/components/blueprint-panel"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useWorkspace } from "@/context/workspace"
import { onMount, onCleanup } from "solid-js"

export function WorkspaceBlueprintsTool() {
  const workspace = useWorkspace()

  onMount(() => {
    workspace.register({
      id: "blueprints",
      label: "Blueprints",
      icon: getSemanticIcon("orchestration.blueprint"),
      component: () => <BlueprintPanel />,
    })
  })

  onCleanup(() => workspace.unregister("blueprints"))

  return null
}

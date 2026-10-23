import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"

export function composeWithExperiments(components: readonly RuntimeComponent[]) {
  return RuntimeComponents.compose(components, FeatureSelection.complete(components))
}

import { SemanticIconToken, type SemanticIconTokenName } from "@ericsanchezok/synergy-plugin/icons"
import type { IconName } from "./icon"

export { SemanticIconToken, type SemanticIconTokenName }

export function getSemanticIcon(token: SemanticIconTokenName): IconName {
  return SemanticIconToken[token]
}

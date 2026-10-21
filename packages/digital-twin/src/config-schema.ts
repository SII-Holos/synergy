import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { DigitalTwinContract } from "./contract"

const ConfigShape = {
  digitalTwin: DigitalTwinContract.Settings.optional().describe(
    "Next-input prediction: automatic defaults to true; model defaults to the current Session model",
  ),
}
type Shape = typeof ConfigShape
declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends Shape {}
}
const contribution = { shape: ConfigShape }
export function registerConfig() {
  ConfigExtensions.register("digital-twin", contribution)
  ConfigDomain.register({
    id: "digital-twin",
    filename: "35-digital-twin.jsonc",
    label: "Digital Twin",
    ownedKeys: ["digitalTwin"],
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: "digital-twin",
    importable: true,
  })
}

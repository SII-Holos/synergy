import { registerConfig as registerLocalConfig } from "@ericsanchezok/synergy-local-runtime/config-schema"
import { registerConfig as registerIntegrationsConfig } from "@ericsanchezok/synergy-agent-integrations/config-schema"
import { registerConfig as registerLibraryConfig } from "@ericsanchezok/synergy-library/config-schema"
import { registerConfig as registerConnectionsConfig } from "@ericsanchezok/synergy-connections/config-schema"
import { registerConfig as registerPluginConfig } from "@ericsanchezok/synergy-plugin-host/config-schema"
import { registerConfig as registerMediaConfig } from "@ericsanchezok/synergy-media/config-schema"
import { registerConfig as registerWorkbenchConfig } from "@ericsanchezok/synergy-workbench/config-schema"
import { registerConfig as registerWorkflowsConfig } from "@ericsanchezok/synergy-workflows/config-schema"
import { registerSessionSchema } from "@ericsanchezok/synergy-workflows/session-schema"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export function registerProductConfiguration() {
  registerLocalConfig()
  registerIntegrationsConfig()
  registerLibraryConfig()
  registerConnectionsConfig()
  registerPluginConfig()
  registerMediaConfig()
  registerWorkbenchConfig()
  registerWorkflowsConfig()
  registerSessionSchema()
  ConfigExtensions.completeRegistration()
}

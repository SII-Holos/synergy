import "@ericsanchezok/synergy-runtime-local/config-schema"
import "@ericsanchezok/synergy-agent-integrations/config-schema"
import "@ericsanchezok/synergy-library/config-schema"
import "@ericsanchezok/synergy-connections/config-schema"
import "@ericsanchezok/synergy-plugin-host/config-schema"
import "@ericsanchezok/synergy-media/config-schema"
import "@ericsanchezok/synergy-workbench/config-schema"
import "@ericsanchezok/synergy-workflows/config-schema"
import "@ericsanchezok/synergy-workflows/session-schema"

import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"

ConfigExtensions.completeRegistration()

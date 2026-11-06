import { registerConfig as registerBossConfig } from "@ericsanchezok/synergy-boss/config-schema"
import { registerConfig as registerAnimaConfig } from "@ericsanchezok/synergy-anima/config-schema"
import { registerConfig as registerGithubConfig } from "@ericsanchezok/synergy-github/config-schema"
import { registerConfig as registerEmailConfig } from "@ericsanchezok/synergy-email/config-schema"
import { registerConfig as registerChannelGithubConfig } from "@ericsanchezok/synergy-channel-github/config-schema"
import { registerConfig as registerChannelFeishuConfig } from "@ericsanchezok/synergy-channel-feishu/config-schema"
import { registerConfig as registerChannelsConfig } from "@ericsanchezok/synergy-channels/config-schema"
import { registerConfig as registerLocalConfig } from "@ericsanchezok/synergy-local-runtime/config-schema"
import { registerConfig as registerMcpConfig } from "@ericsanchezok/synergy-mcp/config-schema"
import { registerConfig as registerExternalAgentsConfig } from "@ericsanchezok/synergy-external-agents/config-schema"
import { registerConfig as registerFormatterConfig } from "@ericsanchezok/synergy-formatter/config-schema"
import { registerConfig as registerLspConfig } from "@ericsanchezok/synergy-lsp/config-schema"
import { registerConfig as registerLibraryConfig } from "@ericsanchezok/synergy-library/config-schema"
import { registerConfig as registerPluginConfig } from "@ericsanchezok/synergy-plugin-host/config-schema"
import { registerConfig as registerMediaConfig } from "@ericsanchezok/synergy-media/config-schema"
import { registerConfig as registerWorkbenchConfig } from "@ericsanchezok/synergy-workbench/config-schema"
import { registerConfig as registerDigitalTwinConfig } from "@ericsanchezok/synergy-digital-twin/config-schema"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export function registerFullConfiguration() {
  registerLocalConfig()
  registerMcpConfig()
  registerExternalAgentsConfig()
  registerFormatterConfig()
  registerLspConfig()
  registerLibraryConfig()
  registerDigitalTwinConfig()
  registerPluginConfig()
  registerMediaConfig()
  registerWorkbenchConfig()
  registerChannelsConfig()
  registerChannelFeishuConfig()
  registerChannelGithubConfig()
  registerEmailConfig()
  registerGithubConfig()
  registerBossConfig()
  registerAnimaConfig()
  ConfigExtensions.completeRegistration()
}

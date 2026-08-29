import { SkillSourceProviders } from "../instruction/source-provider"
import { Plugin } from "./index"

/**
 * H7 source inversion: the skill domain consumes plugin skill entries
 * through the L1 SkillSourceProviders registry, so skill no longer imports
 * the plugin domain and the product layer stays acyclic. The provider is
 * late-bound to Plugin.skillEntries so test doubles keep intercepting.
 */
export function registerPluginSkillSource() {
  SkillSourceProviders.register("plugin", () => Plugin.skillEntries())
}

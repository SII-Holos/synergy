import type { Migration } from "../migration"
import { Global } from "../global"
import { ConfigReferenceMigration } from "./reference-migration"
import { retireFeaturePreferences } from "./feature-migration"
import { isRecord } from "../util/is-record"

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

const retiredFeatures = ["holos", "channel-clarus"]

export const identityRetirement: Migration = {
  id: "20261026-retire-network-config",
  description: "Remove retired identity and channel configuration",
  scope: "global",
  execution: "startup",
  configuration: "files",
  upgradeConfig(config) {
    delete config.holos
    delete config.holos_friend_reply_model
    const channels = record(config.channel)
    for (const [id, value] of Object.entries(channels ?? {})) {
      const type = record(value)?.type
      if (id === "holos" || id === "clarus" || type === "holos" || type === "clarus") delete channels![id]
    }
    if (channels && !Object.keys(channels).length) delete config.channel
    const features = record(config.features)
    if (Array.isArray(features?.optIn))
      features.optIn = features.optIn.filter((id) => typeof id !== "string" || !retiredFeatures.includes(id))
  },
  async up(progress) {
    await ConfigReferenceMigration.up(progress)
    await retireFeaturePreferences(Global.Path.config, retiredFeatures)
  },
}

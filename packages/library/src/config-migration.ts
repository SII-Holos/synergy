import { ConfigReferenceMigration } from "@ericsanchezok/synergy-harness/config/reference-migration"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { MEMORY_CATEGORIES } from "./config-schema"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mergeMissing(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined) target[key] = structuredClone(value)
    else if (record(target[key]) && record(value)) mergeMissing(target[key], value)
  }
}

function removeEmpty(parent: Record<string, unknown>, key: string) {
  if (record(parent[key]) && !Object.keys(parent[key]).length) delete parent[key]
}

function evolution(value: Record<string, unknown>): Record<string, unknown> {
  const memory: Record<string, unknown> = {}
  const experience: Record<string, unknown> = {}
  if (typeof value.active === "boolean") {
    memory.enabled = value.active
    delete value.active
  } else if (record(value.active)) {
    const active = value.active
    if (typeof active.retrieve === "boolean") {
      if (!active.retrieve) memory.enabled = false
      delete active.retrieve
    } else if (record(active.retrieve)) {
      memory.retrieval = active.retrieve
      delete active.retrieve
    }
    if (typeof active.memoryDedupThreshold === "number") {
      memory.dedup = { threshold: active.memoryDedupThreshold }
      delete active.memoryDedupThreshold
    }
    removeEmpty(value, "active")
  }
  if (typeof value.passive === "boolean") {
    experience.encode = value.passive
    experience.retrieve = value.passive
    delete value.passive
  } else if (record(value.passive)) {
    const passive = value.passive
    if (typeof passive.encode === "boolean") {
      experience.encode = passive.encode
      delete passive.encode
    }
    if (typeof passive.retrieve === "boolean" || record(passive.retrieve)) {
      experience.retrieve = passive.retrieve
      delete passive.retrieve
    }
    if (record(passive.learning)) {
      experience.learning = passive.learning
      delete passive.learning
    }
    removeEmpty(value, "passive")
  }
  return {
    ...(Object.keys(memory).length ? { memory } : {}),
    ...(Object.keys(experience).length ? { experience } : {}),
  }
}

function upgradeConfig(config: Record<string, unknown>) {
  if (config.library !== undefined && !record(config.library)) return
  const library: Record<string, unknown> = record(config.library) ? config.library : {}
  if (record(config.engram)) {
    mergeMissing(library, config.engram)
    delete config.engram
  }
  for (const key of ["memory", "experience"]) {
    if (!record(config[key])) continue
    mergeMissing(library, { [key]: config[key] })
    delete config[key]
  }
  if (typeof config.autonomy === "boolean") {
    mergeMissing(library, { autonomy: config.autonomy })
    delete config.autonomy
  }
  if (record(config.identity)) {
    const identity = config.identity
    for (const key of ["embedding", "rerank"]) {
      if (!record(identity[key]) || (config[key] !== undefined && !record(config[key]))) continue
      mergeMissing(config, { [key]: identity[key] })
      delete identity[key]
    }
    if (typeof identity.evolution === "boolean") {
      mergeMissing(library, {
        memory: { enabled: identity.evolution },
        experience: { encode: identity.evolution, retrieve: identity.evolution },
      })
      delete identity.evolution
    } else if (record(identity.evolution)) {
      mergeMissing(library, evolution(identity.evolution))
      removeEmpty(identity, "evolution")
    }
    if (typeof identity.autonomy === "boolean") {
      mergeMissing(library, { autonomy: identity.autonomy })
      delete identity.autonomy
    }
    removeEmpty(config, "identity")
  }
  if (record(library.memory)) {
    const memory = library.memory
    if (typeof memory.retrieval === "boolean") {
      if (!memory.retrieval && memory.enabled === undefined) memory.enabled = false
      delete memory.retrieval
    }
    if (record(memory.retrieval) && record(memory.retrieval.categories)) {
      for (const category of MEMORY_CATEGORIES) {
        if (!Object.hasOwn(memory.retrieval.categories, category)) memory.retrieval.categories[category] = {}
      }
    }
  }
  if (record(library.experience) && typeof library.experience.learning === "boolean") {
    delete library.experience.learning
  }
  if (Object.keys(library).length) config.library = library
}

export const configMigration: Migration = {
  id: "20261012-library-config-owner",
  configuration: "files",
  description: "Upgrade legacy knowledge configuration only when Library is selected",
  scope: "global",
  execution: "startup",
  upgradeConfig,
  up: (progress) => ConfigReferenceMigration.up(progress, { relocateKeys: ["embedding", "rerank", "library"] }),
}

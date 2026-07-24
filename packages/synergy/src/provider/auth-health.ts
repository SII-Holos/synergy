import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { ScopeContext } from "@/scope/context"
import z from "zod"
import type { Auth } from "./api-key"

export namespace ProviderAuthHealth {
  export const Info = z
    .object({
      providerID: z.string(),
      status: z.enum(["connected", "not_configured", "exhausted", "action_required"]),
      recovery: z.enum(["reconnect", "update_environment"]).optional(),
      authKind: z.string().optional(),
      source: z.string().optional(),
      updatedAt: z.number().optional(),
      cooldownUntil: z.number().optional(),
      resetAt: z.number().optional(),
      failureCode: z.string().optional(),
    })
    .meta({ ref: "ProviderAuthHealth" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "provider.auth.updated",
      z.object({
        health: Info,
      }),
    ),
  }

  const observations = new Map<string, Info>()

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  function recovery(source: string | undefined): Info["recovery"] {
    return source === "env" ? "update_environment" : "reconnect"
  }

  function usable(item: Auth.PoolEntry, now = nowSeconds()) {
    if (item.status === "dead") return false
    if (item.status === "active") return true
    const cooldownActive = item.cooldownUntil !== undefined && item.cooldownUntil > now
    const resetActive = item.resetAt !== undefined && item.resetAt > now
    return !cooldownActive && !resetActive
  }

  function storedHealth(providerID: string, entry: Auth.StoreEntry | undefined): Info {
    if (!entry) return { providerID, status: "not_configured" }

    const pool = entry.pool ?? []
    if (pool.length === 0 || pool.some((item) => usable(item))) {
      return {
        providerID,
        status: "connected",
        authKind: entry.authKind,
        source: entry.source,
        updatedAt: entry.updatedAt,
      }
    }

    const dead = pool.find((item) => item.status === "dead")
    if (dead && pool.every((item) => item.status === "dead")) {
      return {
        providerID,
        status: "action_required",
        recovery: recovery(dead.source ?? entry.source),
        authKind: dead.authKind ?? entry.authKind,
        source: dead.source ?? entry.source,
        updatedAt: dead.updatedAt ?? entry.updatedAt,
        failureCode: dead.failureCode,
      }
    }

    const exhausted = pool.find((item) => item.status === "exhausted")
    if (exhausted) {
      return {
        providerID,
        status: "exhausted",
        authKind: exhausted.authKind ?? entry.authKind,
        source: exhausted.source ?? entry.source,
        updatedAt: exhausted.updatedAt ?? entry.updatedAt,
        cooldownUntil: exhausted.cooldownUntil,
        resetAt: exhausted.resetAt,
        failureCode: exhausted.failureCode,
      }
    }

    return {
      providerID,
      status: "action_required",
      recovery: recovery(entry.source),
      authKind: entry.authKind,
      source: entry.source,
      updatedAt: entry.updatedAt,
    }
  }

  export function fromEntry(providerID: string, entry: Auth.StoreEntry | undefined): Info {
    return observations.get(providerID) ?? storedHealth(providerID, entry)
  }

  export function observe(input: Info) {
    const previous = observations.get(input.providerID)
    const next = Info.parse({ ...input, updatedAt: input.updatedAt ?? Date.now() })
    observations.set(input.providerID, next)
    return publishIfChanged(previous, next)
  }

  export function clearObservation(providerID: string, entry?: Auth.StoreEntry) {
    const previous = observations.get(providerID)
    if (!previous) return Promise.resolve()
    observations.delete(providerID)
    return publishIfChanged(previous, storedHealth(providerID, entry))
  }

  export function commitStored(previous: Info, providerID: string, entry?: Auth.StoreEntry) {
    observations.delete(providerID)
    return publishIfChanged(previous, storedHealth(providerID, entry))
  }

  function comparable(info: Info) {
    return {
      providerID: info.providerID,
      status: info.status,
      recovery: info.recovery,
      authKind: info.authKind,
      source: info.source,
      cooldownUntil: info.cooldownUntil,
      resetAt: info.resetAt,
      failureCode: info.failureCode,
    }
  }

  async function publishIfChanged(previous: Info | undefined, next: Info) {
    if (previous && JSON.stringify(comparable(previous)) === JSON.stringify(comparable(next))) return
    if (process.env.SYNERGY_AGENT_WORKER === "1") return
    if (!ScopeContext.tryScope()) return
    await Bus.publish(Event.Updated, { health: next })
  }
}

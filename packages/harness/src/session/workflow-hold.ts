import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { SessionInteraction } from "./interaction"
import type { PausedInfo } from "./types"

/**
 * Move a retired workflow-owned hold onto the session's own pause latch.
 *
 * `LoopStatus.waiting` was a workflow's pause authority: a loop the user held sat
 * in it, and the bound session rendered the matching `waiting` phase. Pause
 * authority is now the session latch alone, so a store written before that change
 * holds a stop nobody owns. This module reads the retired shape and produces the
 * latch that replaces it, so both the loop migration and the session migration
 * describe the same stop with one definition instead of one per caller.
 *
 * The latch is written directly rather than through `SessionLifecycle.pause`.
 * The writer is the single authority for a live pause, but it cannot serve a
 * migration: it publishes through the session index and imports through
 * `SessionCompat`, which needs an ambient Scope and refuses to run inside the
 * deferred-import transaction. Migrations run at bootstrap with no Scope and also
 * per Session during that import, so `isLatchable` mirrors
 * `SessionLifecycle.latchable` — the archived, machine and Cortex exclusions are
 * one rule owned there and copied here, and the two must move together.
 */
export namespace SessionWorkflowHold {
  /** Cause shown for a session stopped by a workflow. Held in step with
   *  `adjudicateOrphanedLoop`, so an upgraded store and a freshly adjudicated one
   *  describe the same stop the same way. */
  export const DESCRIPTION = "Stopped by BlueprintLoop; continue or abandon"

  function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  }

  /** Whether the latch applies to this stored record at all. Mirrors
   *  `SessionLifecycle.latchable`: a missing or archived `time` is unreachable
   *  state, an `unattended` interaction is driven by a domain that reconciles its
   *  own work, and a Cortex delegation is a machine session in everything but that
   *  field. */
  export function isLatchable(info: Record<string, unknown> | undefined): boolean {
    if (!info) return false
    const time = asRecord(info.time)
    if (!time || time.archived) return false
    const interaction = SessionInteraction.Info.safeParse(info.interaction)
    if (interaction.success && SessionInteraction.isUnattended(interaction.data)) return false
    if (info.cortex) return false
    return true
  }

  /** The latch a retired hold becomes, or undefined when the session already
   *  carries a pause or the latch does not apply. First pause wins, so a session
   *  another path already stopped keeps the reason it recorded. */
  export function latchFor(info: Record<string, unknown> | undefined): PausedInfo | undefined {
    if (!info || info.paused !== undefined) return undefined
    if (!isLatchable(info)) return undefined
    return { reason: "workflow", description: DESCRIPTION, since: Date.now() }
  }

  /** Latch a bound Session that is already resident. A Session still living in a
   *  deferred aggregate has no canonical record yet; its own deferred migration
   *  applies the latch when it imports. */
  export async function latch(scopeID: string, sessionID: string): Promise<boolean> {
    const key = StoragePath.sessionInfo(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID))
    const info = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
    const paused = latchFor(info)
    if (!paused) return false
    await Storage.write(key, { ...info, paused })
    return true
  }
}

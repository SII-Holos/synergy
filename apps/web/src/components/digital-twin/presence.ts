import { Persist } from "@/utils/persist"

export type DigitalTwinOwner = { url: string; scopeKey: string; sessionID: string }
export type DigitalTwinSuggestion = { rootID: string; assistantID: string; proposalID: string; text: string }

const composers = new Map<string, Set<(suggestion: DigitalTwinSuggestion) => void>>()
const claimed = new Set<string>()

function ownerKey(owner: DigitalTwinOwner) {
  return JSON.stringify([owner.url, owner.scopeKey, owner.sessionID])
}

/** The storage entry this Session's saved suggestion lives in. */
function storageKey(owner: DigitalTwinOwner) {
  const target = Persist.scoped(Persist.scopeKey(owner.url, owner.scopeKey), owner.sessionID, "digital-twin")
  return `${target.storage}:${target.key}`
}

/**
 * A mounted composer owns its Session's automatic prediction: it can show the
 * pending state and it already holds the completion subscription. The
 * Scope-level predictor stands down for those Sessions and covers every other
 * one, which is what lets a suggestion arrive for a Session the user has left.
 */
export function registerComposer(owner: DigitalTwinOwner, receive: (suggestion: DigitalTwinSuggestion) => void) {
  const key = ownerKey(owner)
  const consumers = composers.get(key) ?? new Set()
  consumers.add(receive)
  composers.set(key, consumers)
  return () => {
    consumers.delete(receive)
    if (!consumers.size) composers.delete(key)
  }
}

export function composerMounted(owner: DigitalTwinOwner) {
  return composers.has(ownerKey(owner))
}

/** One automatic attempt per finished turn, whichever predictor sees it first. */
export function claimCompletion(owner: DigitalTwinOwner, rootID: string, assistantID: string) {
  const key = JSON.stringify([ownerKey(owner), rootID, assistantID])
  if (claimed.has(key)) return false
  if (claimed.size >= 512) claimed.delete(claimed.values().next().value!)
  claimed.add(key)
  return true
}

/**
 * Writes the record the composer already persists, so a suggestion produced
 * while that composer was unmounted is present the next time it mounts.
 */
export function saveSuggestion(owner: DigitalTwinOwner, suggestion: DigitalTwinSuggestion) {
  const consumers = composers.get(ownerKey(owner))
  if (consumers?.size) {
    for (const receive of consumers) receive(suggestion)
    return
  }
  localStorage.setItem(storageKey(owner), JSON.stringify({ version: 1, suggestion }))
}

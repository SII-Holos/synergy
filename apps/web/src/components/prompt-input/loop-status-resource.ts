import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import { blueprintLoopFeatureAvailable } from "../note/blueprint-run-session"
import { isTerminalBlueprintLoopStatus } from "./blueprint-slot"
import type { LoopHistoryHint, LoopTerminal } from "./loop-status"

type Epoch = { selection: unknown; reconnect: number }
type Snapshot = {
  epoch?: Epoch
  blueprint?: BlueprintLoopInfo
  blueprintBinding?: string
  blueprintRead?: string
  blueprintError?: boolean
  blueprintRevision: number
  light?: LoopTerminal
  lightActive?: boolean
  hadLight?: boolean
  lightRead?: string
  lightInstructions?: string
  lightError?: boolean
  lightRevision: number
  lightReview?: string
  lightHint?: string
}
const caches = new WeakMap<object, Map<string, Snapshot>>()

export function createLoopStatusResource(input: {
  client: object
  owner: Accessor<{ sessionID: string; scopeID: string } | undefined>
  loopID: Accessor<string | undefined>
  lightActive: Accessor<boolean>
  lightInstructions?: Accessor<string | undefined>
  lightReviewer?: Accessor<string | undefined>
  history: Accessor<LoopHistoryHint>
  reconnect: Accessor<number>
  selection: Accessor<unknown>
  hasFeature: (id: string) => boolean
  getBlueprint: (id: string, scopeID: string, signal: AbortSignal) => Promise<BlueprintLoopInfo | undefined>
  getTerminal: (sessionID: string, scopeID: string, signal: AbortSignal) => Promise<LoopTerminal | undefined>
}) {
  let cache = caches.get(input.client)
  if (!cache) {
    cache = new Map()
    caches.set(input.client, cache)
  }
  const retained = cache
  const [retryVersion, retry] = createSignal(0)
  const requests = new Set<AbortController>()
  let blueprintOwner: Snapshot | undefined
  let blueprintRequest: AbortController | undefined
  let terminalRequest: AbortController | undefined
  onCleanup(() => {
    for (const request of requests) request.abort()
    requests.clear()
  })
  const [version, setVersion] = createSignal(0)
  const key = (owner: { sessionID: string; scopeID: string }) => JSON.stringify([owner.scopeID, owner.sessionID])
  const epoch = createMemo(() => ({ selection: input.selection(), reconnect: input.reconnect() }))
  const snapshot = createMemo(() => {
    version()
    const owner = input.owner(),
      current = epoch()
    const value = owner ? retained.get(key(owner)) : undefined
    return value && value.epoch?.selection === current.selection ? { ...value } : undefined
  })
  const touch = (owner: { sessionID: string; scopeID: string }) => {
    const id = key(owner),
      value = retained.get(id) ?? { blueprintRevision: 0, lightRevision: 0 }
    retained.delete(id)
    retained.set(id, value)
    while (retained.size > 32) retained.delete(retained.keys().next().value!)
    return value
  }
  const publish = () => setVersion((v) => v + 1)
  const available = (loop: BlueprintLoopInfo) => blueprintLoopFeatureAvailable(loop, input.hasFeature)
  createEffect(() => {
    retryVersion()
    const current = epoch(),
      owner = input.owner(),
      binding = input.loopID(),
      lightActive = input.lightActive(),
      lightReviewer = input.lightReviewer?.(),
      history = input.history()
    if (!owner) {
      blueprintOwner = undefined
      return
    }
    const value = touch(owner)
    const loopID = binding ?? history.blueprintID ?? value.blueprint?.id
    if (value.epoch?.selection !== current.selection || value.epoch?.reconnect !== current.reconnect) {
      value.blueprintRead = undefined
      value.lightRead = undefined
      value.blueprintRevision++
      value.lightRevision++
    }
    if (
      (blueprintOwner !== value || value.blueprintBinding !== binding) &&
      (value.blueprint?.id !== loopID || !isTerminalBlueprintLoopStatus(value.blueprint?.status))
    ) {
      value.blueprintRead = undefined
      value.blueprintRevision++
    }
    blueprintOwner = value
    value.blueprintBinding = binding
    value.epoch = current
    if (value.lightActive !== lightActive) {
      value.lightRevision++
      if (lightActive) {
        value.light = undefined
        value.lightRead = undefined
        value.lightReview = undefined
      } else if (value.lightActive) value.lightRead = undefined
    }
    if (lightActive) {
      value.hadLight = true
      value.lightHint = history.light
      if (lightReviewer) value.lightReview = lightReviewer
      value.lightInstructions = untrack(() => input.lightInstructions?.())
      value.lightError = false
    }
    const hadLight = value.hadLight
    value.lightActive = lightActive
    if (loopID && input.hasFeature("blueprint") && value.blueprintRead !== loopID) {
      value.blueprintRead = loopID
      value.blueprintError = false
      const request = new AbortController(),
        revision = ++value.blueprintRevision
      blueprintRequest = request
      requests.add(request)
      void input
        .getBlueprint(loopID, owner.scopeID, request.signal)
        .then((loop) => {
          if (request.signal.aborted || retained.get(key(owner)) !== value || value.blueprintRevision !== revision)
            return
          value.blueprint =
            loop &&
            loop.id === loopID &&
            available(loop) &&
            loop.sessionID === owner.sessionID &&
            loop.scopeID === owner.scopeID
              ? loop
              : undefined
          value.blueprintError =
            !value.blueprint || (!binding && !isTerminalBlueprintLoopStatus(value.blueprint.status))
          publish()
        })
        .catch(() => {
          if (value.blueprintRevision === revision && !request.signal.aborted) {
            value.blueprintRead = undefined
            value.blueprintError = true
            publish()
          }
        })
        .finally(() => requests.delete(request))
    }
    const reviewer = value.lightReview && value.lightHint === history.light ? value.lightReview : history.lightReview
    const terminalKey = reviewer ? `review:${reviewer}` : (history.light ?? "terminal")
    if (
      !lightActive &&
      (history.light || hadLight) &&
      input.hasFeature("light-loop") &&
      value.lightRead !== terminalKey
    ) {
      value.lightRead = terminalKey
      terminalRequest?.abort()
      const request = new AbortController(),
        revision = ++value.lightRevision
      terminalRequest = request
      requests.add(request)
      void input
        .getTerminal(owner.sessionID, owner.scopeID, request.signal)
        .then((terminal) => {
          if (request.signal.aborted || retained.get(key(owner)) !== value || value.lightRevision !== revision) return
          value.light = terminal
          value.lightError = !terminal
          publish()
        })
        .catch(() => {
          if (value.lightRevision === revision && !request.signal.aborted) {
            value.lightRead = undefined
            value.lightError = true
            publish()
          }
        })
        .finally(() => requests.delete(request))
    }
    const pendingBlueprint = blueprintRequest
    const blueprintRevision = value.blueprintRevision
    const pendingTerminal = terminalRequest
    const terminalRevision = value.lightRevision
    onCleanup(() => {
      const next = untrack(input.owner)
      const nextEpoch = untrack(epoch)
      const nextBinding = untrack(input.loopID)
      const nextLoopID = nextBinding ?? untrack(input.history).blueprintID ?? value.blueprint?.id
      if (
        pendingBlueprint &&
        requests.has(pendingBlueprint) &&
        (!next ||
          key(next) !== key(owner) ||
          nextBinding !== binding ||
          nextLoopID !== loopID ||
          nextEpoch.selection !== current.selection ||
          nextEpoch.reconnect !== current.reconnect)
      ) {
        pendingBlueprint.abort()
        if (value.blueprintRevision === blueprintRevision) value.blueprintRead = undefined
      }
      if (
        pendingTerminal &&
        requests.has(pendingTerminal) &&
        (!next ||
          key(next) !== key(owner) ||
          untrack(input.lightActive) ||
          nextEpoch.selection !== current.selection ||
          nextEpoch.reconnect !== current.reconnect)
      ) {
        pendingTerminal.abort()
        if (value.lightRevision === terminalRevision) value.lightRead = undefined
      }
    })
    publish()
  })
  return {
    blueprint: () => {
      const loop = snapshot()?.blueprint
      const binding = input.loopID()
      return loop && (!binding || loop.id === binding) && available(loop) ? loop : undefined
    },
    blueprintUnavailable: () => snapshot()?.blueprintError,
    awaitingTerminal: () => {
      const value = snapshot()
      return input.hasFeature("light-loop") &&
        !input.lightActive() &&
        (value?.hadLight || value?.lightError !== undefined) &&
        !value?.light
        ? { instructions: value?.lightInstructions ?? "", error: value?.lightError }
        : undefined
    },
    retry() {
      const owner = untrack(input.owner)
      const value = owner && retained.get(key(owner))
      if (!value) return
      value.lightRead = undefined
      value.blueprintRead = undefined
      value.lightError = false
      value.blueprintError = false
      retry((n) => n + 1)
    },
    terminal: () => (input.hasFeature("light-loop") && !input.lightActive() ? snapshot()?.light : undefined),
    update(loop: BlueprintLoopInfo) {
      if (!available(loop)) return
      const owner = untrack(input.owner),
        id = key(loop)
      if (!retained.has(id) && (!owner || key(owner) !== id)) return
      const value = touch(loop)
      const binding = owner && key(owner) === id ? untrack(input.loopID) : value.blueprintBinding
      if (binding && loop.id !== binding) return
      if (
        value.blueprint &&
        (!binding || value.blueprint.id === loop.id) &&
        value.blueprint.time.updated > loop.time.updated
      )
        return
      value.blueprint = loop
      value.blueprintError = false
      value.blueprintRead = loop.id
      value.blueprintRevision++
      value.epoch = untrack(epoch)
      publish()
    },
  }
}

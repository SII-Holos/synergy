import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { isSessionResourceTerminalEvent } from "@ericsanchezok/synergy-harness/session/event"
import { BrowserOwner } from "./owner.js"
import { BrowserBroker } from "./broker.js"
import { BrowserHostPage } from "./host-page.js"
import { BrowserProfiles } from "./profiles.js"
import { BrowserNetworkGateway } from "./network-gateway.js"
import { BrowserEvent } from "./event.js"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionWorkspaceRuntime } from "@ericsanchezok/synergy-harness/session/workspace-runtime"
import { withinBrowserOwner } from "./owner-context"

import type { BrowserSession } from "./types.js"
export { type BrowserSession } from "./types.js"

interface BrowserCommandExecutor {
  disposeOwner(owner: BrowserOwner.Info, dispose: () => Promise<void>): Promise<void>
  clear(): void
}

const runtimeState = RuntimeContext.state(() => ({
  commandExecutor: undefined as BrowserCommandExecutor | undefined,
}))

/** BrowserCommandService owns owner-scoped disposal queues; it registers its
 * executor at module load so the runtime never imports it back. */
export function registerBrowserCommandExecutor(executor: BrowserCommandExecutor): void {
  const instanceState = runtimeState()

  instanceState.commandExecutor = executor
}

function requireCommandExecutor(): BrowserCommandExecutor {
  const instanceState = runtimeState()

  if (!instanceState.commandExecutor) throw new Error("Browser command executor is not registered")
  return instanceState.commandExecutor
}

export namespace BrowserRuntime {
  const log = Log.create({ service: "browser.runtime" })
  export const withinOwner = withinBrowserOwner

  const runtimeState = RuntimeContext.state(() => ({
    sessions: new Map<string, BrowserSession>(),
    sessionPromises: new Map<string, Promise<BrowserSession>>(),
    disposalPromises: new Map<string, Promise<void>>(),
    memberships: new Map<string, Map<string, BrowserSession>>(),
    running: false,
    profileSubscription: undefined as (() => void) | undefined,
    reaperInstalled: false,
  }))

  const workspaceSessions = WorkspaceState.create(
    () => new Map<string, BrowserSession>(),
    async (sessions) => {
      for (const [key, session] of sessions) {
        if (runtimeState().sessions.get(key) === session) await invalidateSession(session.owner)
      }
    },
  )

  function forgetSession(key: string) {
    const current = runtimeState()
    current.sessions.delete(key)
    current.memberships.get(key)?.delete(key)
    current.memberships.delete(key)
  }

  export async function invalidateSession(owner: BrowserOwner.Info): Promise<void> {
    const key = BrowserOwner.key(owner)
    await runtimeState().sessionPromises.get(key)
    await requireCommandExecutor().disposeOwner(owner, async () => {
      const session = runtimeState().sessions.get(key)
      const pageIDs = session?.pages.map((page) => page.id) ?? []
      await session?.dispose()
      forgetSession(key)
      for (const pageId of pageIDs) BrowserEvent.publish(owner, { type: "page.closed", pageId })
    })
  }

  function installSessionReaper() {
    const instanceState = runtimeState()

    if (instanceState.reaperInstalled) return
    instanceState.reaperInstalled = true
    GlobalBus().on("event", (event) => {
      const payload = event?.payload
      const info = payload?.properties?.info
      if (!info?.id) return
      if (!isSessionResourceTerminalEvent(payload)) return
      const scopeID = info.scope?.id
      if (!scopeID) return
      const owner: BrowserOwner.Info = {
        mode: "session",
        scopeID,
        directory: info.scope?.directory ?? "",
        sessionID: info.id,
      }
      void disposeSession(owner).catch((error) =>
        log.warn("failed to dispose browser session on lifecycle event", { sessionID: info.id, error }),
      )
    })
  }

  export async function ensure(): Promise<void> {
    const instanceState = runtimeState()

    if (instanceState.running) return
    installSessionReaper()

    instanceState.running = true
  }

  export async function stop(): Promise<void> {
    const instanceState = runtimeState()

    const failures: unknown[] = []
    collectFailures(await Promise.allSettled(Array.from(instanceState.disposalPromises.values())), failures)
    collectFailures(await Promise.allSettled(Array.from(instanceState.sessionPromises.values())), failures)
    const executor = requireCommandExecutor()
    collectFailures(
      await Promise.allSettled(
        Array.from(instanceState.sessions.values(), (session) =>
          executor.disposeOwner(session.owner, () => session.dispose()),
        ),
      ),
      failures,
    )
    for (const session of instanceState.sessions.values()) {
      BrowserBroker.release(session.owner)
      BrowserEvent.remove(session.owner)
    }
    for (const key of instanceState.sessions.keys()) forgetSession(key)
    instanceState.sessionPromises.clear()
    executor.clear()

    instanceState.running = false
    for (const stop of [() => BrowserNetworkGateway.stop()]) {
      try {
        await stop()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, "Browser runtime shutdown did not complete cleanly.")
  }

  /** Dispose a specific BrowserSession. */
  export function disposeSession(owner: BrowserOwner.Info): Promise<void> {
    const instanceState = runtimeState()

    const k = BrowserOwner.key(owner)
    const active = instanceState.disposalPromises.get(k)
    if (active) return active

    const operation = SessionWorkspaceRuntime.withBinding(owner.sessionID ?? `browser-scope:${owner.scopeID}`, () =>
      disposeSessionOnce(owner, k),
    ).finally(() => {
      const instanceState = runtimeState()

      if (instanceState.disposalPromises.get(k) === operation) instanceState.disposalPromises.delete(k)
    })
    instanceState.disposalPromises.set(k, operation)
    return operation
  }

  async function disposeSessionOnce(owner: BrowserOwner.Info, key: string): Promise<void> {
    const instanceState = runtimeState()

    const pending = instanceState.sessionPromises.get(key)
    if (pending) await pending
    const session = instanceState.sessions.get(key)
    if (!session) return
    await requireCommandExecutor().disposeOwner(owner, () => session.dispose())
    forgetSession(key)
    BrowserBroker.release(owner)
    BrowserEvent.remove(owner)
  }

  /** Create or retrieve a BrowserSession for the given owner. */
  export async function getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    return withinOwner(owner, createSession)
  }

  async function createSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    const instanceState = runtimeState()

    BrowserOwner.assertValid(owner)
    installSessionReaper()
    const k = BrowserOwner.key(owner)
    const existing = instanceState.sessions.get(k)
    if (existing) return existing
    const pending = instanceState.sessionPromises.get(k)
    if (pending) return pending
    const create = (async () => {
      const instanceState = runtimeState()

      const { BrowserSessionImpl } = await import("./session.js")
      const session = new BrowserSessionImpl(owner, async (input) => {
        if (input.adopt) return BrowserHostPage.adopt({ ...input, owner })
        return BrowserHostPage.create({
          ...input,
          owner,
          routeDirectory: BrowserBroker.preference(owner)?.routeDirectory ?? owner.directory ?? "/",
          presentation: "native",
        })
      })
      instanceState.profileSubscription ??= BrowserProfiles.onChange(async (profileId) => {
        const profile = await BrowserProfiles.get(profileId)
        if (!profile.enabled)
          await Promise.all([...instanceState.sessions.values()].map((value) => value.suspendProfile(profileId)))
      })
      BrowserBroker.onPopup(owner, (input) => withinOwner(owner, () => session.adoptPage(input)))
      instanceState.sessions.set(k, session)
      await session.restore()
      if (ScopeContext.current.workspace) {
        const members = workspaceSessions()
        members.set(k, session)
        instanceState.memberships.set(k, members)
      }
      return session
    })().finally(() => {
      const instanceState = runtimeState()
      return instanceState.sessionPromises.delete(k)
    })
    instanceState.sessionPromises.set(k, create)
    return create
  }

  export async function clearProfile(id: string, restoreEnabled = true): Promise<void> {
    const profile = await BrowserProfiles.get(id)
    const wasDefault = (await BrowserProfiles.list()).defaultProfileId === id
    await BrowserProfiles.update(id, { enabled: false })
    await BrowserBroker.clearProfile(profile)
    if (profile.enabled && restoreEnabled) {
      await BrowserProfiles.update(id, { enabled: true })
      if (wasDefault) await BrowserProfiles.setDefault(id)
    }
  }

  export function resourceStats() {
    const instanceState = runtimeState()

    const values = [...instanceState.sessions.values()]
    const pages = values.flatMap((session) => session.pages)
    const activePages = pages.filter((page) => page.status === "active")
    return {
      status: BrowserBroker.ready("native") ? ("ready" as const) : ("unavailable" as const),
      processCount: 0,
      measuredProcessCount: 0,
      ownerCount: values.length,
      sessionOwnerCount: values.filter((session) => session.owner.mode === "session").length,
      scopeOwnerCount: values.filter((session) => session.owner.mode === "scope").length,
      activePageCount: activePages.length,
      hostPageCount: activePages.length,
      headlessPageCount: 0,
      suspendedPageCount: pages.length - activePages.length,
    }
  }

  function collectFailures(results: PromiseSettledResult<unknown>[], failures: unknown[]): void {
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason)
    }
  }
}

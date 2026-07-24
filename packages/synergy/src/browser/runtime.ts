import { Log } from "../util/log"
import { GlobalBus } from "../bus/global"
import { CortexTypes } from "../cortex/types"
import { BrowserOwner } from "./owner.js"
import { PlaywrightBrowserDriver } from "./playwright-driver.js"
import type { BrowserDriver } from "./driver.js"
import { BrowserBroker } from "./broker.js"
import { BrowserHostPage } from "./host-page.js"
import { BrowserNetworkGateway } from "./network-gateway.js"
import { BrowserHostBrokerProcess } from "./host-broker-process.js"
import { BrowserEvent } from "./event.js"

import type { BrowserSession } from "./types.js"
export { type BrowserSession } from "./types.js"

export namespace BrowserRuntime {
  const log = Log.create({ service: "browser.runtime" })

  const sessions = new Map<string, BrowserSession>()
  const sessionPromises = new Map<string, Promise<BrowserSession>>()
  const disposalPromises = new Map<string, Promise<void>>()
  let running = false
  let driver: BrowserDriver.Driver | null = null

  let reaperInstalled = false
  function installSessionReaper() {
    if (reaperInstalled) return
    reaperInstalled = true
    GlobalBus.on("event", (event) => {
      const payload = event?.payload
      const info = payload?.properties?.info
      if (!info?.id) return
      const archived = payload.type === "session.updated" && info.time?.archived
      const deleted = payload.type === "session.deleted"
      const cortexTerminal = payload.type === "session.updated" && CortexTypes.isTerminalStatus(info.cortex?.status)
      if (!archived && !deleted && !cortexTerminal) return
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
    if (running) return
    installSessionReaper()

    const pwDriver = new PlaywrightBrowserDriver()
    await pwDriver.ensure()
    driver = pwDriver
    running = true
  }

  export async function stop(): Promise<void> {
    const failures: unknown[] = []
    collectFailures(await Promise.allSettled(Array.from(disposalPromises.values())), failures)
    collectFailures(await Promise.allSettled(Array.from(sessionPromises.values())), failures)
    const { BrowserCommandService } = await import("./command-service.js")
    collectFailures(
      await Promise.allSettled(
        Array.from(sessions.values(), (session) =>
          BrowserCommandService.disposeOwner(session.owner, () => session.dispose()),
        ),
      ),
      failures,
    )
    for (const session of sessions.values()) {
      BrowserNetworkGateway.revoke(session.owner)
      BrowserBroker.release(session.owner)
      BrowserEvent.remove(session.owner)
    }
    sessions.clear()
    sessionPromises.clear()
    BrowserCommandService.clear()

    if (driver) {
      try {
        await driver.stop()
      } catch (error) {
        log.error("browser.playwright.stop.failed", { error })
        failures.push(error)
      }
      driver = null
    }

    running = false
    for (const stop of [() => BrowserNetworkGateway.stop(), () => BrowserHostBrokerProcess.stop()]) {
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
    const k = BrowserOwner.key(owner)
    const active = disposalPromises.get(k)
    if (active) return active

    const operation = disposeSessionOnce(owner, k).finally(() => {
      if (disposalPromises.get(k) === operation) disposalPromises.delete(k)
    })
    disposalPromises.set(k, operation)
    return operation
  }

  async function disposeSessionOnce(owner: BrowserOwner.Info, key: string): Promise<void> {
    const pending = sessionPromises.get(key)
    if (pending) await pending
    const session = sessions.get(key)
    if (!session) return
    const { BrowserCommandService } = await import("./command-service.js")
    await BrowserCommandService.disposeOwner(owner, () => session.dispose())
    sessions.delete(key)
    BrowserNetworkGateway.revoke(owner)
    BrowserBroker.release(owner)
    BrowserEvent.remove(owner)
  }

  /** Create or retrieve a BrowserSession for the given owner. */
  export async function getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    BrowserOwner.assertValid(owner)
    installSessionReaper()
    const k = BrowserOwner.key(owner)
    const disposing = disposalPromises.get(k)
    if (disposing) await disposing
    const existing = sessions.get(k)
    if (existing) return existing
    const pending = sessionPromises.get(k)
    if (pending) return pending
    const create = (async () => {
      const { BrowserSessionImpl } = await import("./session.js")
      const session = new BrowserSessionImpl(
        owner,
        driverForSession,
        async (input) => {
          if (input.backend !== "host") return null
          const preference = BrowserBroker.preference(owner)
          if (preference) {
            return BrowserHostPage.create({
              owner,
              id: input.id ?? crypto.randomUUID(),
              routeDirectory: preference.routeDirectory,
              presentation: preference.presentation,
              events: input.events,
            })
          }
          return null
        },
        () => (BrowserBroker.preference(owner) ? "host" : "headless"),
      )
      sessions.set(k, session)
      await session.restore()
      return session
    })().finally(() => sessionPromises.delete(k))
    sessionPromises.set(k, create)
    return create
  }

  export function resourceStats() {
    const values = [...sessions.values()]
    const activePages = values.filter((session) => session.page?.isAlive())
    const hostPages = activePages.filter((session) => session.page?.backend === "host")
    const headlessPages = activePages.filter((session) => session.page?.backend === "headless")
    const host = BrowserHostBrokerProcess.resourceStats()
    return {
      ...host,
      processCount: host.processCount + (headlessPages.length > 0 ? 1 : 0),
      ownerCount: values.length,
      sessionOwnerCount: values.filter((session) => session.owner.mode === "session").length,
      scopeOwnerCount: values.filter((session) => session.owner.mode === "scope").length,
      activePageCount: activePages.length,
      hostPageCount: hostPages.length,
      headlessPageCount: headlessPages.length,
      suspendedPageCount: values.filter((session) => session.status === "suspended").length,
    }
  }

  async function driverForSession(): Promise<BrowserDriver.Driver> {
    await ensure()
    if (!driver) throw new Error("Browser driver not running")
    return driver
  }

  function collectFailures(results: PromiseSettledResult<unknown>[], failures: unknown[]): void {
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason)
    }
  }
}

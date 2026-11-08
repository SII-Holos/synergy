import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore, type StoreOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { ensureMigrations } from "@ericsanchezok/synergy-harness/migration"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { registerOrganizationMigrations } from "./migration"
import { OrganizationStoragePath } from "./storage/path"
import { organizationApp } from "./http"

export interface OrganizationServiceOptions {
  home: string
  database?: Extract<StoreOptions, { backend: "postgres" }>
}

export async function openOrganizationService(options: OrganizationServiceOptions) {
  if (!path.isAbsolute(options.home)) throw new Error("Organization Home must be absolute")
  const home = path.resolve(options.home)
  const root = path.join(home, ".synergy")
  const context = RuntimeContext.create(
    {
      home,
      root,
      env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
    },
    "server",
  )
  return context.run(async () => {
    let ownership: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
    let store: TransactionalStore | undefined
    let ready = false
    let closing: Promise<void> | undefined
    const active = new Set<Promise<unknown>>()
    async function run<T>(body: () => T | Promise<T>): Promise<T> {
      if (!ready) throw new Error("Organization service is closed")
      const pending = context.run(async () => body())
      active.add(pending)
      try {
        return await pending
      } finally {
        active.delete(pending)
      }
    }
    function close() {
      if (closing) return closing
      ready = false
      closing = (async () => {
        await Promise.allSettled([...active])
        const errors: unknown[] = []
        try {
          await store?.close()
        } catch (error) {
          errors.push(error)
        }
        try {
          await ownership?.release()
        } catch (error) {
          errors.push(error)
        }
        context.dispose()
        if (errors.length) throw new AggregateError(errors, "Organization service cleanup failed")
      })()
      return closing
    }
    try {
      ownership = await ServerProcessLock.acquire()
      await fs.mkdir(path.join(root, "data"), { recursive: true, mode: 0o700 })
      store = await TransactionalStore.open(
        options.database ?? {
          backend: "sqlite",
          namespace: "organization",
          filename: path.join(root, "data", "organization.sqlite"),
        },
      )
      context.storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
      registerOrganizationMigrations()
      MigrationRegistry.lock()
      RuntimeContext.sealComposition()
      await ensureMigrations({ output: "silent" })
      OrganizationProtocol.Deployment.parse(await Storage.read(OrganizationStoragePath.deployment()))
      const app = organizationApp(() => ready)
      ready = true
      RuntimeContext.setReady(true)
      return {
        home,
        fetch: (request: Request) => run(() => app.fetch(request)),
        deployment: () =>
          run(async () =>
            OrganizationProtocol.Deployment.parse(await Storage.read(OrganizationStoragePath.deployment())),
          ),
        capabilities: () =>
          run(() => ({ protocolVersion: OrganizationProtocol.version, executesAgents: false as const })),
        close,
        [Symbol.asyncDispose]: close,
      }
    } catch (error) {
      try {
        await close()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Organization service startup failed")
      }
      throw error
    }
  })
}

import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { TransactionalStore, type StoreOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { ensureMigrations } from "@ericsanchezok/synergy-harness/migration"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { registerOrganizationMigrations } from "./migration"
import { OrganizationStoragePath } from "./storage/path"
import { organizationApp } from "./http"
import { createAuthentication } from "./auth"
import { createClientAuthentication } from "./auth/client"
import {
  OrganizationSettings,
  registerConfig,
  type AuthenticationSettings,
  type ClientAuthenticationSettings,
  type RuntimeRegistrationSettings,
  type RuntimeConnectionSettings,
} from "./config-schema"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { createRuntimeRegistrations } from "./runtime-registration"
import type { Server } from "bun"
import { createRuntimeConnections, type RuntimeConnections, type RuntimeSocket } from "./runtime-connection"
import { organizationWeb } from "./web"
import { loadSigningAuthority } from "./signing"
import { OrganizationAuthorityHistory } from "./authority-history"
import { OrganizationKnowledge } from "./knowledge"
import { OrganizationArtifacts } from "./artifacts"
import { createCommandAdmissions } from "./command-admission"
import { createCommandForwarder } from "./command-forwarding"
import { createExecutionGrants } from "./execution-grants"
import { createGatewayCalls } from "./gateway-calls"
import { createConnectionGateway, createModelGateway, type ConnectionGateway, type ModelGateway } from "./gateway"
import { OrganizationSharing } from "./sharing"
import { OrganizationCloud, type OrganizationCloudOptions } from "./cloud"
import { OrganizationSessionDirectory } from "./session-directory"
import { createHandoffs, registerHandoffAuthorityHistory } from "./handoff"
import { createSessionReadForwarder } from "./session-read"
import { OrganizationServiceMaintenance } from "./service-maintenance"
import { OrganizationServiceHome } from "./service-home"

export interface OrganizationServiceOptions {
  home: string
  database?: Extract<StoreOptions, { backend: "postgres" }>
  publicOrigin?: string
  authentication?: AuthenticationSettings
  clientAuthentication?: ClientAuthenticationSettings
  registration?: RuntimeRegistrationSettings
  connections?: RuntimeConnectionSettings
  web?: { directory: string }
  cloud?: OrganizationCloudOptions
}

export async function openOrganizationService(options: OrganizationServiceOptions) {
  const entry = await openOrganizationNamespace(options, "serve")
  if (entry.mode !== "serve") throw new Error("Organization service startup selected another native mode")
  const { mode: _, ...service } = entry
  return service
}

export async function openOrganizationServiceHomeUpgrade(
  options: Pick<OrganizationServiceOptions, "home" | "database" | "cloud">,
) {
  const entry = await openOrganizationNamespace(options, "upgrade")
  if (entry.mode !== "upgrade") throw new Error("Organization upgrade startup selected another native mode")
  const { mode: _, ...upgrade } = entry
  return upgrade
}

async function openOrganizationNamespace(options: OrganizationServiceOptions, mode: "serve" | "upgrade") {
  if (!path.isAbsolute(options.home)) throw new Error("Organization Home must be absolute")
  const settings = OrganizationSettings.parse({
    authentication: options.authentication,
    clientAuthentication: options.clientAuthentication,
    registration: options.registration,
    connections: options.connections,
  })
  if (settings.clientAuthentication?.clients.length && !options.publicOrigin)
    throw new Error("Client authentication requires an organization public origin")
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin)
    if (url.origin !== options.publicOrigin || url.protocol !== "https:")
      throw new Error("Organization public origin must be an HTTPS origin")
  }
  const web = mode === "serve" && options.web ? await organizationWeb(options.web.directory) : undefined
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
    let connections: RuntimeConnections | undefined
    let modelGateway: ModelGateway | undefined
    let connectionGateway: ConnectionGateway | undefined
    const active = new Set<Promise<unknown>>()
    async function run<T>(body: () => T | Promise<T>): Promise<T> {
      if (!ready) throw new Error("Organization service is closed")
      const pending = context.run(() => OrganizationServiceMaintenance.run(body))
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
      closing = context.run(async () => {
        RuntimeContext.setReady(false)
        connections?.close()
        await modelGateway?.close()
        await connectionGateway?.close()
        await Promise.allSettled([...active])
        await OrganizationServiceMaintenance.stop()
        const errors: unknown[] = []
        try {
          ObservabilityMetrics.stop()
        } catch (error) {
          errors.push(error)
        }
        try {
          await ObservabilityStore.stop()
        } catch (error) {
          errors.push(error)
        }
        try {
          Storage.closeArtifactAdmission()
          await Storage.drainArtifactPreparations()
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
      })
      return closing
    }
    try {
      registerConfig()
      if (mode === "serve") OrganizationServiceHome.select()
      else await OrganizationServiceHome.selectForUpgrade()
      ownership = await ServerProcessLock.acquire()
      const owned = await HomeOwnership.assert()
      const data = path.join(root, "data")
      const entries: string[] = await fs.readdir(data).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      if (!owned && entries.length && !entries.includes("organization.sqlite"))
        throw new Error("Organization service requires a dedicated Home without personal Runtime data")
      await fs.mkdir(path.join(root, "data"), { recursive: true, mode: 0o700 })
      store = await TransactionalStore.open(
        options.database ?? {
          backend: "sqlite",
          namespace: "organization",
          filename: path.join(root, "data", "organization.sqlite"),
        },
      )
      context.storage = { store, artifactDirectory: path.join(root, "data", "artifacts") }
      OrganizationAuthorityHistory.register()
      registerHandoffAuthorityHistory()
      OrganizationKnowledge.registerAuthorityHistory()
      OrganizationArtifacts.registerAuthorityHistory()
      OrganizationCloud.registerAuthorityHistory()
      registerOrganizationMigrations()
      await OrganizationServiceHome.assertStartupOwner()
      OrganizationServiceMaintenance.register()
      OrganizationServiceHome.registerNamespaceIdentity()
      OrganizationCloud.register(options.cloud)
      OrganizationSessionDirectory.registerRuntimeStatus(async (runtimeID) => {
        if (!connections) throw new Error("Organization Runtime presence is unavailable")
        return connections.availability(runtimeID)
      })
      MigrationRegistry.lock()
      RuntimeContext.sealComposition()
      await ensureMigrations({ output: "silent" })
      await HomeOwnership.assert({ required: true })
      const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(OrganizationStoragePath.deployment()))
      const signing = await loadSigningAuthority(deployment)
      await OrganizationAuthorityHistory.attach(deployment)
      const maintenance = Object.freeze({
        async run<T>(body: () => Promise<T>): Promise<T> {
          if (!ready) throw new Error("Organization service is closed")
          const pending = context.run(body)
          active.add(pending)
          try {
            return await pending
          } finally {
            active.delete(pending)
          }
        },
      })
      if (mode === "upgrade") {
        ready = true
        RuntimeContext.setReady(true)
        return {
          mode: "upgrade" as const,
          home,
          maintenance,
          upgrade(input: Omit<Parameters<typeof OrganizationServiceHome.upgrade>[0], "home">) {
            return maintenance.run(() => OrganizationServiceHome.upgrade({ ...input, home }))
          },
          close,
          [Symbol.asyncDispose]: close,
        }
      }
      connections = createRuntimeConnections({
        run,
        captureTail: OrganizationServiceMaintenance.captureTail,
        settings: settings.connections,
        signingIdentity: signing.identity,
        onResult: (connection, result) => admissions.observe(connection, result),
        onSyncState: (connection, sessionID) => OrganizationSharing.getFromRuntime(connection.handshake, sessionID),
        onSyncBatch: (connection, batch) => OrganizationSharing.applyBatchFromRuntime(connection.handshake, batch),
        onBlobChunk: (connection, input) => OrganizationSharing.uploadBlobFromRuntime(connection.handshake, input),
      })
      const admissions = createCommandAdmissions({ connections, signing })
      const commands = createCommandForwarder({ admissions, connections })
      const reads = createSessionReadForwarder({ connections, signing })
      const gatewayCalls = createGatewayCalls({ connections, signing })
      modelGateway = createModelGateway({
        calls: gatewayCalls,
        run: async (body) => context.run(body),
        captureTail: OrganizationServiceMaintenance.captureTail,
      })
      connectionGateway = createConnectionGateway({
        calls: gatewayCalls,
        run: async (body) => context.run(body),
        captureTail: OrganizationServiceMaintenance.captureTail,
      })
      const handoffs = createHandoffs({ connections, signing })
      const execution = createExecutionGrants({
        admissions,
        connections,
        handoffs,
        assertResourcesDrained(grantID) {
          modelGateway!.assertDrained(grantID)
          connectionGateway!.assertDrained(grantID)
        },
      })
      const authentication = await createAuthentication(settings.authentication, connections.removeAccount)
      const clientAuthentication = createClientAuthentication(settings.clientAuthentication, options.publicOrigin)
      const registrations = createRuntimeRegistrations(settings.registration, connections.revoke)
      const app = organizationApp(
        () => ready,
        authentication,
        options.publicOrigin,
        registrations,
        connections,
        clientAuthentication,
        commands,
        execution,
        { calls: gatewayCalls, models: modelGateway, connections: connectionGateway },
        handoffs,
        reads,
      )
      if (web) app.route("/", web)
      ready = true
      RuntimeContext.setReady(true)
      return {
        mode: "serve" as const,
        home,
        bootstrapToken: () => run(() => authentication.bootstrapToken()),
        async fetch(request: Request, server?: Server<RuntimeSocket>) {
          try {
            return await run(() => app.fetch(request, { server }))
          } catch (error) {
            if (!(error instanceof RuntimeMaintenance.Blocked)) throw error
            return Response.json(
              {
                code: "SERVICE_UNAVAILABLE",
                message: "Organization maintenance holds new operations",
                outcome: "not_dispatched",
                retryable: true,
              },
              { status: 503 },
            )
          }
        },
        maintenance,
        websocket: connections.websocket,
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

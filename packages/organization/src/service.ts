import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
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
import { createOrganizationNotifications, type OrganizationNotifications } from "./notifications"
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
import { OrganizationServiceNative } from "./backup/service-native"
import { OrganizationSourceRetirement } from "./backup/source-retirement"
import { OrganizationCurrentAuthority } from "./backup/current-authority"
import { OrganizationSourcePreparation } from "./backup/source-preparation"
import { OrganizationRecoveryPublication } from "./backup/publication"
import { readOrganizationConfiguration } from "./configuration"
import { OrganizationHealth } from "./health"
import { OrganizationRetention } from "./retention"

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

export async function openOrganizationRecovery(options: Pick<OrganizationServiceOptions, "home" | "database">) {
  const entry = await openOrganizationNamespace(options, "recovery")
  if (entry.mode !== "recovery") throw new Error("Organization recovery startup selected another native mode")
  const { mode: _, ...recovery } = entry
  return recovery
}

export async function openOrganizationSourceRetirement(
  options: Pick<OrganizationServiceOptions, "home" | "database"> & {
    reference: OrganizationSourceRetirement.Reference
  },
) {
  const reference = OrganizationSourceRetirement.Reference.parse(structuredClone(options.reference))
  const entry = await openOrganizationNamespace(options, "retirement", reference)
  if (entry.mode !== "retirement") throw new Error("Organization retirement startup selected another native mode")
  const { mode: _, ...retirement } = entry
  return retirement
}

export async function openOrganizationPendingRetirement(
  options: Pick<OrganizationServiceOptions, "home"> & { reference: OrganizationSourceRetirement.Reference },
) {
  const reference = OrganizationSourceRetirement.Reference.parse(structuredClone(options.reference))
  const entry = await openOrganizationNamespace(options, "pending-retirement", reference)
  if (entry.mode !== "pending-retirement") throw new Error("Pending source selected another native mode")
  const { mode: _, ...source } = entry
  return source
}

export async function openOrganizationSourcePreparation(
  options: OrganizationServiceOptions & { preparation: OrganizationSourcePreparation.Original },
) {
  const { preparation, ...selected } = options
  const entry = await openOrganizationNamespace(selected, "source-preparation", undefined, preparation)
  if (entry.mode !== "source-preparation") throw new Error("Source preparation selected another native mode")
  const { mode: _, ...source } = entry
  return source
}

async function openOrganizationNamespace(
  options: OrganizationServiceOptions,
  mode: "serve" | "upgrade" | "recovery" | "retirement" | "pending-retirement" | "source-preparation",
  retirement?: OrganizationSourceRetirement.Reference,
  preparation?: OrganizationSourcePreparation.Original,
) {
  if (!path.isAbsolute(options.home)) throw new Error("Organization Home must be absolute")
  const selectedHome = path.resolve(options.home)
  let publicOrigin = options.publicOrigin
  const webOptions = options.web ? { ...options.web } : undefined
  const database = options.database ? { ...options.database } : undefined
  const cloud = options.cloud
  let settings = OrganizationSettings.parse({
    authentication: options.authentication,
    clientAuthentication: options.clientAuthentication,
    registration: options.registration,
    connections: options.connections,
  })
  if (settings.clientAuthentication?.clients.length && !publicOrigin)
    throw new Error("Client authentication requires an organization public origin")
  if (publicOrigin) {
    const url = new URL(publicOrigin)
    if (url.origin !== publicOrigin || url.protocol !== "https:")
      throw new Error("Organization public origin must be an HTTPS origin")
  }
  const existingHome =
    mode === "serve"
      ? await fs.lstat(selectedHome).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      : undefined
  if (existingHome && (!existingHome.isDirectory() || existingHome.isSymbolicLink()))
    throw new Error("Organization Home requires an ordinary native directory")
  const home = existingHome ? await fs.realpath(selectedHome) : selectedHome
  const web = mode === "serve" && webOptions ? await organizationWeb(webOptions.directory) : undefined
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
    let restored = false
    let closing: Promise<void> | undefined
    let connections: RuntimeConnections | undefined
    let notifications: OrganizationNotifications | undefined
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
        notifications?.close()
        connections?.close()
        await modelGateway?.close()
        await connectionGateway?.close()
        await Promise.allSettled([...active])
        await OrganizationServiceMaintenance.stop()
        const errors: unknown[] = []
        try {
          await OrganizationCurrentAuthority.drainPending()
          await OrganizationSourceRetirement.drain()
          await OrganizationRecoveryPublication.drain()
        } catch (error) {
          errors.push(error)
        }
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
      HomeRestoration.register()
      OrganizationRecoveryPublication.register()
      RuntimeMaintenance.registerProtection()
      if (mode === "source-preparation") await OrganizationSourcePreparation.selectOwner()
      else if (mode === "upgrade") await OrganizationServiceHome.selectForUpgrade()
      else if (mode === "recovery") await OrganizationServiceHome.selectForRecovery()
      else if (mode === "retirement" || mode === "pending-retirement") {
        if (!retirement) throw new Error("Source retirement requires its original reference")
        await OrganizationServiceHome.selectForRetirement(OrganizationSourceRetirement.marker(retirement))
      } else restored = await OrganizationServiceHome.selectForStartup()
      ownership = await ServerProcessLock.acquire()
      if (mode !== "recovery" && mode !== "retirement" && mode !== "pending-retirement" && !restored)
        await HomeRestoration.assertOrdinaryStartup()
      const owned = mode === "retirement" || mode === "pending-retirement" ? undefined : await HomeOwnership.assert()
      const data = path.join(root, "data")
      const entries: string[] = await fs.readdir(data).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      if (!owned && entries.length && !entries.includes("organization.sqlite"))
        throw new Error("Organization service requires a dedicated Home without personal Runtime data")
      await fs.mkdir(path.join(root, "data"), { recursive: true, mode: 0o700 })
      store = await TransactionalStore.open(
        database ?? {
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
      if (restored) {
        const completed = await HomeRestoration.inspectCompleted()
        await HomeRestoration.assertOrdinaryStartup()
        publicOrigin ??= (await OrganizationRecoveryPublication.read(completed.installationID)).publicOrigin
        const configuration = await readOrganizationConfiguration(home)
        settings = OrganizationSettings.parse({
          ...configuration,
          ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)),
        })
      }
      if (mode !== "recovery" && mode !== "retirement" && mode !== "pending-retirement") {
        await OrganizationServiceHome.assertStartupOwner()
        OrganizationServiceMaintenance.register()
        OrganizationServiceHome.registerNamespaceIdentity()
        OrganizationCloud.register(cloud)
        if (mode === "serve" || mode === "source-preparation")
          OrganizationServiceNative.register({ ...settings, publicOrigin, web: webOptions, database, cloud })
        if (mode === "source-preparation") {
          if (!preparation) throw new Error("Source preparation requires its original Target and work capability")
          OrganizationSourcePreparation.register(preparation)
        }
        OrganizationSessionDirectory.registerRuntimeStatus(async (runtimeID) => {
          if (!connections) throw new Error("Organization Runtime presence is unavailable")
          return connections.availability(runtimeID)
        })
      }
      if (mode === "pending-retirement") {
        OrganizationServiceMaintenance.register()
        OrganizationCurrentAuthority.registerPendingSource()
      }
      MigrationRegistry.lock()
      RuntimeContext.sealComposition()
      async function runMaintenance<T>(body: () => Promise<T>): Promise<T> {
        if (!ready) throw new Error("Organization service is closed")
        const pending = context.run(body)
        active.add(pending)
        try {
          return await pending
        } finally {
          active.delete(pending)
        }
      }
      const maintenance = Object.freeze({
        run: runMaintenance,
        retention: Object.freeze({
          uploads: Object.freeze({
            async status(input: OrganizationRetention.Uploads.TargetInput) {
              if (mode !== "serve") throw new Error("Retention requires an ordinary organization service")
              const original = structuredClone(input)
              return runMaintenance(() => OrganizationRetention.Uploads.status(original))
            },
            async mark(input: OrganizationRetention.Uploads.MarkInput) {
              if (mode !== "serve") throw new Error("Retention requires an ordinary organization service")
              const original = structuredClone(input)
              return runMaintenance(() => OrganizationRetention.Uploads.mark(original))
            },
            async collect(input: OrganizationRetention.Uploads.TargetInput) {
              if (mode !== "serve") throw new Error("Retention requires an ordinary organization service")
              const original = structuredClone(input)
              return runMaintenance(() => OrganizationRetention.Uploads.collect(original))
            },
          }),
          async status(input: OrganizationRetention.TargetInput) {
            if (mode !== "serve") throw new Error("Retention requires an ordinary organization service")
            const original = structuredClone(input)
            return runMaintenance(() => OrganizationRetention.status(original))
          },
          async mark(input: OrganizationRetention.MarkInput) {
            if (mode !== "serve") throw new Error("Retention requires an ordinary organization service")
            const original = structuredClone(input)
            return runMaintenance(() => OrganizationRetention.mark(original))
          },
          async collect(input: OrganizationRetention.TargetInput) {
            if (mode !== "serve") throw new Error("Retention requires an ordinary organization service")
            const original = structuredClone(input)
            return runMaintenance(() => OrganizationRetention.collect(original))
          },
        }),
      })
      if (mode === "recovery") {
        ready = true
        return { mode: "recovery" as const, home, run: maintenance.run, close, [Symbol.asyncDispose]: close }
      }
      if (mode === "source-preparation") {
        const deployment = OrganizationProtocol.Deployment.parse(
          await Storage.read(OrganizationStoragePath.deployment()),
        )
        await loadSigningAuthority(deployment)
        await OrganizationAuthorityHistory.attach(deployment)
        ready = true
        return { mode: "source-preparation" as const, home, run: maintenance.run, close, [Symbol.asyncDispose]: close }
      }
      if (mode === "pending-retirement") {
        if (!retirement) throw new Error("Pending retirement requires its original reference")
        ready = true
        return {
          mode: "pending-retirement" as const,
          home,
          source: OrganizationCurrentAuthority.pendingSource(retirement),
          run: maintenance.run,
          close,
          [Symbol.asyncDispose]: close,
        }
      }
      if (mode === "retirement") {
        if (!retirement) throw new Error("Source retirement requires its original reference")
        await OrganizationSourceRetirement.assertReserved(retirement)
        ready = true
        const reference = retirement
        return {
          mode: "retirement" as const,
          home,
          run: maintenance.run,
          complete: () => maintenance.run(() => OrganizationSourceRetirement.complete(reference)),
          close,
          [Symbol.asyncDispose]: close,
        }
      }
      await ensureMigrations({ output: "silent" })
      await HomeOwnership.assert({ required: true })
      const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(OrganizationStoragePath.deployment()))
      const signing = await loadSigningAuthority(deployment)
      await OrganizationAuthorityHistory.attach(deployment)
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
      notifications = createOrganizationNotifications({ run })
      connections = createRuntimeConnections({
        run,
        captureTail: OrganizationServiceMaintenance.captureTail,
        settings: settings.connections,
        signingIdentity: signing.identity,
        onResult: (connection, result) => admissions.observe(connection, result),
        onSyncState: (connection, sessionID) => OrganizationSharing.getFromRuntime(connection.handshake, sessionID),
        onSyncBatch: (connection, batch) => OrganizationSharing.applyBatchFromRuntime(connection.handshake, batch),
        onNotification: (connection, notice) => notifications!.publish(connection, notice),
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
      const clientAuthentication = createClientAuthentication(settings.clientAuthentication, publicOrigin)
      const registrations = createRuntimeRegistrations(settings.registration, connections.revoke)
      const app = organizationApp(
        () => ready,
        authentication,
        publicOrigin,
        registrations,
        connections,
        clientAuthentication,
        commands,
        execution,
        { calls: gatewayCalls, models: modelGateway, connections: connectionGateway },
        handoffs,
        reads,
        notifications,
      )
      if (web) app.route("/", web)
      ready = true
      RuntimeContext.setReady(true)
      return {
        mode: "serve" as const,
        home,
        bootstrapToken: () => run(() => authentication.bootstrapToken()),
        async fetch(request: Request, server?: Server<RuntimeSocket>) {
          if (OrganizationHealth.kind(request)) {
            if (!ready) return OrganizationHealth.response(request, () => false)
            return context.run(() => app.fetch(request, { server }))
          }
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

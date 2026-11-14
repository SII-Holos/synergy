import fs from "node:fs/promises"
import { constants, fstatSync, lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { withStorageQueueOptions } from "@ericsanchezok/synergy-harness/storage/queue"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore, type StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { Global } from "@ericsanchezok/synergy-harness/global"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationIdentity, OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import {
  OrganizationSettings,
  AuthenticationSettings,
  ClientAuthenticationSettings,
  RuntimeRegistrationSettings,
  RuntimeConnectionSettings,
  ORGANIZATION_CONFIG_FILENAME,
} from "../config-schema"
import { readOrganizationConfigurationSnapshot, parseOrganizationConfiguration } from "../configuration"
import { OrganizationServiceHome } from "../service-home"
import type { OrganizationServiceOptions } from "../service"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
import { OrganizationRecoveryDatabase as Database } from "./database"
import { OrganizationResourceNative as Resources } from "./resources"

export namespace OrganizationServiceNative {
  const Settings = z.strictObject({
    authentication: AuthenticationSettings,
    clientAuthentication: ClientAuthenticationSettings,
    registration: RuntimeRegistrationSettings,
    connections: RuntimeConnectionSettings,
  })
  const Startup = z.strictObject({
    settings: Settings,
    publicOrigin: z.string().url().optional(),
    webRequired: z.boolean(),
    requirements: z.array(z.enum(["database-target", "cloud-composition"])),
    database: Database.Descriptor.optional(),
  })
  const Identity = z.strictObject({ orgID: OrganizationIdentity.ID, deploymentIncarnation: OrganizationIdentity.ID })
  export const Manifest = z.strictObject({
    format: z.literal("synergy-organization-service-native"),
    version: z.literal(1),
    source: StorageCheckpoint.Manifest,
    identity: Identity,
    owner: HomeOwnershipFile.FencedInfo,
    configuration: z
      .strictObject({
        present: z.boolean(),
        settings: OrganizationSettings,
        raw: z
          .strictObject({
            bytes: z
              .number()
              .int()
              .nonnegative()
              .max(4 * 1024 * 1024),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .optional(),
      })
      .refine((value) => value.present === !!value.raw),
    startup: Startup,
    resources: StorageCheckpoint.Manifest.optional(),
  })
  export type Manifest = z.infer<typeof Manifest>
  const state = RuntimeContext.state(() => ({ startup: undefined as z.infer<typeof Startup> | undefined }))
  const key = ["service-native", "manifest"]
  const configurationKey = ["service-native", "configuration"]
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  function fail(message: string): never {
    throw new Error("Service native recovery " + message)
  }
  export function register(options: Omit<OrganizationServiceOptions, "home">) {
    RuntimeContext.assertCompositionOpen("Organization service native recovery")
    if (state().startup) fail("startup is already registered")
    if (options.publicOrigin) {
      const url = new URL(options.publicOrigin)
      if (url.protocol !== "https:" || url.origin !== options.publicOrigin) fail("startup origin is invalid")
    }
    Resources.register(options.cloud)
    const database = Database.capture(options.database)
    state().startup = Startup.parse({
      settings: {
        authentication: AuthenticationSettings.parse(options.authentication ?? {}),
        clientAuthentication: ClientAuthenticationSettings.parse(options.clientAuthentication ?? {}),
        registration: RuntimeRegistrationSettings.parse(options.registration ?? {}),
        connections: RuntimeConnectionSettings.parse(options.connections ?? {}),
      },
      publicOrigin: options.publicOrigin,
      webRequired: !!options.web,
      requirements: [
        ...(database ? ["database-target"] : []),
        ...(options.cloud && Object.values(options.cloud).some((value) => value && Object.keys(value).length)
          ? ["cloud-composition"]
          : []),
      ],
      database,
    })
  }
  interface CaptureInput {
    archive: SnapshotMaintenance.ArchiveEvidence
    lease: RuntimeMaintenance.Lease
    directory: string
    keys: VaultKeyProvider
    signal?: AbortSignal
  }
  export function capture(input: CaptureInput) {
    const provider = input.keys
    const original = {
      archive: input.archive,
      lease: input.lease,
      directory: input.directory,
      signal: input.signal,
      keys: Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) }),
    }
    return withStorageQueueOptions({ signal: original.signal }, () => captureNative(original))
  }
  async function captureNative(input: CaptureInput) {
    const archive = input.archive
    const source = SnapshotMaintenance.assertArchive(archive)
    const lease = input.lease
    const directory = input.directory
    const signal = input.signal
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    if (!path.isAbsolute(directory)) fail("destination must be absolute")
    const startup = state().startup
    if (!startup) fail("requires the actual composition's startup snapshot")
    Database.verify(startup.database, startup.requirements)
    if (startup.requirements.includes("cloud-composition") && !Resources.configured())
      fail("requires a target reconstruction owner for its external composition")
    const runtime = RuntimeContext.current()
    const primary = runtime.storage
    const assert = () => {
      signal?.throwIfAborted()
      SnapshotMaintenance.assertArchive(archive)
      if (RuntimeContext.current() !== runtime || runtime.storage !== primary || state().startup !== startup)
        fail("requires its original startup and primary storage")
      Database.assertSource(startup.database)
    }
    async function frozen() {
      assert()
      if ((await RuntimeMaintenance.assertHeld(lease)).phase !== "frozen") fail("requires frozen native maintenance")
      assert()
    }
    await frozen()
    const proof = await NativeNamespaceIdentity.capture()
    assert()
    const identity = NativeNamespaceIdentity.inspect(proof)
    if (identity.owner !== "organization" || identity.identity.kind !== "service")
      fail("requires its actual service namespace")
    const owner = HomeOwnershipFile.FencedInfo.parse(await HomeOwnership.assert({ required: true }))
    if (owner.owner !== "organization") fail("requires the owning service Home reader")
    OrganizationServiceHome.archivedOwner(owner)
    const root = runtime.host.root
    if (root !== path.join(runtime.host.home, ".synergy")) fail("requires its canonical native Home")
    const configuration = await readOrganizationConfigurationSnapshot(runtime.host.home, { signal })
    try {
      assert()
      await using resource = Resources.required()
        ? await Resources.capture({
            archive,
            lease,
            directory: path.join(path.dirname(directory), "resources"),
            keys,
            signal,
          })
        : undefined
      if (resource) Resources.assertCaptured(resource, archive)
      const resourceInput = resource && {
        directory: resource.directory,
        expected: resource.namespace,
        namespaceDirectory: source.directory,
      }
      const manifest = Manifest.parse({
        format: "synergy-organization-service-native",
        version: 1,
        source: source.namespace,
        identity: Identity.parse({
          orgID: identity.identity.orgID,
          deploymentIncarnation: identity.identity.deploymentIncarnation,
        }),
        owner,
        configuration: {
          present: configuration.present,
          settings: configuration.settings,
          ...(configuration.present
            ? { raw: { bytes: configuration.bytes.byteLength, sha256: hash(configuration.bytes) } }
            : {}),
        },
        startup,
        resources: resource?.namespace,
      })
      const existing = await fs.lstat(directory, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      if (existing) {
        const assertSource = await RuntimeMaintenance.assertSourcePreparationFrozen(lease)
        if (!existing.isDirectory() || existing.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
          fail("existing native capture requires its original canonical directory")
        const held = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const assertExisting = () => {
          assert()
          assertSource()
          const physical = fstatSync(held.fd, { bigint: true })
          const actual = lstatSync(directory, { bigint: true })
          if (
            !physical.isDirectory() ||
            !actual.isDirectory() ||
            actual.isSymbolicLink() ||
            physical.dev !== existing.dev ||
            physical.ino !== existing.ino ||
            actual.dev !== existing.dev ||
            actual.ino !== existing.ino ||
            realpathSync(directory) !== directory
          )
            fail("existing native capture lost its original directory")
        }
        try {
          assertExisting()
          const namespace = await StorageCheckpoint.verifyArchive({ directory, keys, signal })
          const fixed = await verify({
            directory,
            expected: namespace,
            source: source.namespace,
            keys,
            signal,
            resources: resourceInput,
          })
          try {
            const { rawConfiguration: _, ...fixedManifest } = fixed
            if (JSON.stringify(Manifest.parse(fixedManifest)) !== JSON.stringify(manifest))
              fail("existing native capture differs from its actual original settings or namespace")
            await NativeNamespaceIdentity.verify(proof)
            await RuntimeMaintenance.assertSourcePreparationFrozen(lease)
            assertExisting()
            return { directory, namespace, resources: resourceInput }
          } finally {
            fixed.rawConfiguration?.fill(0)
          }
        } finally {
          await held.close()
        }
      }
      const parent = path.join(Global.Path.cache, "service-native-segments")
      await fs.mkdir(parent, { recursive: true, mode: 0o700 })
      const temporary = await fs.mkdtemp(path.join(parent, "capture-"))
      let store: TransactionalStore | undefined
      let complete = false
      let published = false
      try {
        store = await TransactionalStore.open({
          backend: "sqlite",
          namespace: "service-native",
          filename: path.join(temporary, "segment.sqlite"),
        })
        assert()
        const handle = { store, artifactDirectory: path.join(temporary, "artifacts") }
        if (configuration.present)
          await Storage.provide(handle, () => Storage.writeBinary(configurationKey, configuration.bytes))
        await Storage.provide(handle, () => Storage.write(key, manifest))
        assert()
        const namespace = await Storage.provide(handle, () =>
          StorageCheckpoint.exportArchive({
            directory,
            archiveID: "service-native",
            namespaceID: source.namespace.namespaceID,
            buildVersion: source.namespace.buildVersion,
            keys,
            protect: () => true,
            signal,
          }),
        )
        published = true
        await NativeNamespaceIdentity.verify(proof)
        await frozen()
        complete = true
        return { directory, namespace, resources: resourceInput }
      } finally {
        await store?.close()
        await fs.rm(temporary, { recursive: true, force: true })
        if (published && !complete) await fs.rm(directory, { recursive: true, force: true })
      }
    } finally {
      configuration.bytes.fill(0)
    }
  }
  export async function verify(input: {
    directory: string
    expected: StorageCheckpoint.Manifest
    source: StorageCheckpoint.Manifest
    keys: VaultKeyProvider
    signal?: AbortSignal
    resources?: { directory: string; expected: StorageCheckpoint.Manifest; namespaceDirectory: string }
  }): Promise<Manifest & { rawConfiguration?: Uint8Array }> {
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const signal = input.signal
    const resources = input.resources && {
      directory: input.resources.directory,
      expected: StorageCheckpoint.Manifest.parse(input.resources.expected),
      namespaceDirectory: input.resources.namespaceDirectory,
    }
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    let manifest: Manifest | undefined
    let configuration: { sha256: string; size: number } | undefined
    for await (const entry of StorageCheckpoint.entries({ directory, expected, keys, signal })) {
      if (
        entry.type === "artifact" &&
        JSON.stringify(entry.key) === JSON.stringify(configurationKey) &&
        !configuration
      ) {
        configuration = entry.location
        continue
      }
      if (entry.type !== "record" || JSON.stringify(entry.key) !== JSON.stringify(key) || manifest)
        fail("contains an unsupported native record")
      manifest = Manifest.parse(entry.value)
    }
    if (!manifest || JSON.stringify(manifest.source) !== JSON.stringify(source))
      fail("segment belongs to another namespace checkpoint")
    OrganizationServiceHome.archivedOwner(manifest.owner)
    Database.verify(manifest.startup.database, manifest.startup.requirements)
    if (
      manifest.startup.requirements.filter((value) => value === "cloud-composition").length !==
      Number(!!manifest.resources)
    )
      fail("segment requires its owning service resource composition")
    if (manifest.resources) {
      if (!resources || sourceHash(resources.expected) !== sourceHash(manifest.resources))
        fail("segment is missing its exact original native resource facet")
      await Resources.verify({ ...resources, source, keys, signal })
    } else if (resources) fail("segment contains an undeclared resource facet")
    if (manifest.configuration.present !== !!configuration) fail("configuration bytes are missing or undeclared")
    if (!configuration) return manifest
    if (
      !manifest.configuration.raw ||
      configuration.size !== manifest.configuration.raw.bytes ||
      configuration.sha256 !== manifest.configuration.raw.sha256
    )
      fail("configuration artifact changed")
    const rawConfiguration = new Uint8Array(configuration.size)
    let offset = 0
    for await (const bytes of StorageCheckpoint.streamArtifact({ directory, location: configuration, signal })) {
      rawConfiguration.set(bytes, offset)
      offset += bytes.byteLength
    }
    if (
      JSON.stringify(parseOrganizationConfiguration(rawConfiguration, ORGANIZATION_CONFIG_FILENAME)) !==
      JSON.stringify(manifest.configuration.settings)
    )
      fail("configuration meaning changed")
    return { ...manifest, rawConfiguration }
  }
  export function sourceHash(value: StorageCheckpoint.Manifest) {
    return hash(Buffer.from(JSON.stringify(StorageCheckpoint.Manifest.parse(value))))
  }
  export function serviceNamespaceID(value: z.infer<typeof Identity>) {
    const identity = Identity.parse({ orgID: value.orgID, deploymentIncarnation: value.deploymentIncarnation })
    return hash(Buffer.from(JSON.stringify({ kind: "service", ...identity })))
  }
  const CohortMapping = z.strictObject({
    archiveID: OrganizationIdentity.ID,
    pagesHash: OrganizationProtocol.Digest,
    ordinal: z.number().int().nonnegative().safe(),
    source: Identity,
  })
  function assertSource(
    source: StorageCheckpoint.Manifest,
    native: StorageCheckpoint.Manifest,
    cohort: z.infer<typeof CohortMapping>,
  ) {
    const namespaceID = serviceNamespaceID(cohort.source)
    if (
      source.archiveID !== hash(Buffer.from(cohort.archiveID + ":" + cohort.ordinal)) ||
      source.namespaceID !== namespaceID ||
      native.archiveID !== "service-native" ||
      native.namespaceID !== source.namespaceID ||
      native.buildVersion !== source.buildVersion
    )
      fail("installation facets belong to another source namespace or cohort")
  }
  export const InstallationRequest = HomeRestoration.Request.extend({
    owner: z.literal("organization"),
    payload: z.strictObject({
      nativeHash: OrganizationProtocol.Digest,
      snapshot: z.strictObject({ manifestHash: OrganizationProtocol.Digest }),
      cohort: CohortMapping,
      resourcesHash: OrganizationProtocol.Digest.optional(),
    }),
  })
  export type InstallationRequest = z.infer<typeof InstallationRequest>
  export function installationRequest(input: {
    restoreID: string
    source: StorageCheckpoint.Manifest
    expected: StorageCheckpoint.Manifest
    snapshot: StorageCheckpoint.Manifest
    cohort: z.infer<typeof CohortMapping>
    resources?: StorageCheckpoint.Manifest
  }): InstallationRequest {
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const native = StorageCheckpoint.Manifest.parse(input.expected)
    const snapshot = StorageCheckpoint.Manifest.parse(input.snapshot)
    const cohort = CohortMapping.parse(input.cohort)
    assertSource(source, native, cohort)
    if (
      snapshot.archiveID !== "snapshot-segment" ||
      snapshot.namespaceID !== source.namespaceID ||
      snapshot.buildVersion !== source.buildVersion
    )
      fail("installation facets belong to another source namespace or cohort")
    return InstallationRequest.parse({
      restoreID: input.restoreID,
      owner: "organization",
      sourceHash: sourceHash(source),
      payload: {
        nativeHash: sourceHash(native),
        snapshot: { manifestHash: sourceHash(snapshot) },
        cohort,
        ...(input.resources ? { resourcesHash: sourceHash(input.resources) } : {}),
      },
    })
  }
  export interface Installed {
    readonly manifest: Readonly<Manifest>
    readonly ownership: Readonly<HomeOwnershipFile.RestorationInfo>
    assertCurrent(): void
    verify(): Promise<void>
  }
  const installations = new WeakMap<
    Installed,
    { assert(): void; verify(): Promise<void>; manifest: Manifest; namespace: StorageCheckpoint.Manifest }
  >()
  export function assertInstalled(installed: Installed) {
    const current = installations.get(installed)
    if (!current) fail("requires original native installation evidence")
    current.assert()
  }
  export async function verifyInstalled(installed: Installed) {
    assertInstalled(installed)
    await installations.get(installed)!.verify()
    assertInstalled(installed)
  }
  export function inspectInstalled(installed: Installed) {
    assertInstalled(installed)
    const current = installations.get(installed)!
    return {
      manifest: Manifest.parse(current.manifest),
      namespace: StorageCheckpoint.Manifest.parse(current.namespace),
    }
  }
  export interface PublicationSettings {
    readonly kind: "organization-recovery-native-settings"
  }
  const publicationSettings = new WeakMap<
    PublicationSettings,
    { manifest: Manifest; namespace: StorageCheckpoint.Manifest; resources?: Resources.Manifest; assert(): void }
  >()
  export function assertReconstruction(value: PublicationSettings) {
    const original = publicationSettings.get(value)
    if (!original) fail("requires its actual verified native settings")
    original.assert()
    Database.verify(original.manifest.startup.database, original.manifest.startup.requirements)
    Database.assertTarget(original.manifest.startup.database)
    if (original.manifest.startup.requirements.includes("cloud-composition")) {
      if (!original.resources) fail("requires its original verified resource reconstruction owner")
      Resources.assertReconstruction(original.resources)
    } else if (original.resources) fail("contains undeclared resource reconstruction")
    original.assert()
  }
  export function inspectPublicationSettings(value: PublicationSettings) {
    const original = publicationSettings.get(value)
    if (!original) fail("requires its actual verified native settings")
    original.assert()
    return {
      manifest: Manifest.parse(original.manifest),
      namespace: StorageCheckpoint.Manifest.parse(original.namespace),
    }
  }
  export async function withPublicationSettings<T>(
    input: Parameters<typeof verify>[0],
    body: (settings: PublicationSettings) => Promise<T>,
  ) {
    const provider = input.keys
    const selected = {
      directory: input.directory,
      signal: input.signal,
      keys: Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) }),
      expected: StorageCheckpoint.Manifest.parse(input.expected),
      source: StorageCheckpoint.Manifest.parse(input.source),
      resources: input.resources && {
        directory: input.resources.directory,
        expected: StorageCheckpoint.Manifest.parse(input.resources.expected),
        namespaceDirectory: input.resources.namespaceDirectory,
      },
    }
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const artifacts = primary.artifactDirectory
    const objects = primary.artifactObjects
    const ports = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
    const config = JSON.stringify(store.options)
    let open = true
    let database: Database.Descriptor | undefined
    let verifiedBackend = false
    const assert = () => {
      if (
        !open ||
        RuntimeContext.current() !== runtime ||
        Storage.current().store !== store ||
        Storage.current().artifactDirectory !== artifacts ||
        Storage.current().artifactObjects !== objects ||
        runtime.storage !== primary ||
        primary.store !== store ||
        primary.artifactDirectory !== artifacts ||
        primary.artifactObjects !== objects ||
        objects?.blobs !== ports?.blobs ||
        objects?.writerID !== ports?.writerID ||
        objects?.now !== ports?.now ||
        JSON.stringify(store.options) !== config
      )
        fail("native settings require their original callback and primary Store")
      selected.signal?.throwIfAborted()
      if (verifiedBackend) Database.assertTarget(database)
    }
    const verified = await verify(selected)
    database = verified.startup.database
    verifiedBackend = true
    try {
      assert()
      const resourceMaterial =
        verified.resources && selected.resources
          ? await Resources.verify({
              ...selected.resources,
              source: selected.source,
              keys: selected.keys,
              signal: selected.signal,
            })
          : undefined
      assert()
      const settings: PublicationSettings = Object.freeze({ kind: "organization-recovery-native-settings" })
      const { rawConfiguration: _, ...manifest } = verified
      publicationSettings.set(settings, {
        manifest: Manifest.parse(manifest),
        namespace: selected.expected,
        resources: resourceMaterial,
        assert,
      })
      return await body(settings)
    } finally {
      open = false
      verified.rawConfiguration?.fill(0)
    }
  }
  export async function publicationReady(value: z.infer<typeof Settings>, released = false) {
    const settings = Settings.parse(value)
    const current = await readOrganizationConfigurationSnapshot(RuntimeContext.current().host.home)
    if (released) return true
    return (
      current.present &&
      hash(Buffer.from(JSON.stringify(current.settings))) === hash(Buffer.from(JSON.stringify(settings)))
    )
  }
  export async function publishSettings(permit: HomeRestoration.PublicationPermit, value: z.infer<typeof Settings>) {
    const settings = Settings.parse(structuredClone(value))
    HomeRestoration.assertPublication(permit)
    const runtime = RuntimeContext.current()
    await FileAtomicWrite.withRoot(runtime.host.root, async (root) => {
      await HomeRestoration.verifyPublication(permit)
      await FileAtomicWrite.write(
        root,
        ["config", "synergy.d", ORGANIZATION_CONFIG_FILENAME],
        Buffer.from(JSON.stringify({ organization: settings }) + "\n"),
      )
      HomeRestoration.assertPublication(permit)
    })
    await HomeRestoration.verifyPublication(permit)
    if (!(await publicationReady(settings))) fail("current native settings did not complete")
    HomeRestoration.assertPublication(permit)
  }
  export async function adoptRestoration(
    tx: StoreTransaction,
    input: {
      permit: HomeRestoration.InstallPermit
      request: InstallationRequest
      native: Installed
      snapshot: Parameters<typeof SnapshotMaintenance.assertInstalledSegment>[0]
      archive: StorageCheckpoint.ImportEvidence
    },
  ) {
    const permit = input.permit
    const request = InstallationRequest.parse(structuredClone(input.request))
    const native = input.native
    const snapshot = input.snapshot
    const archive = input.archive
    const assert = () => {
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertRequest(permit, request)
      assertInstalled(native)
      SnapshotMaintenance.assertInstalledSegment(snapshot)
    }
    assert()
    const imported = StorageCheckpoint.assertImport(archive, tx)
    const installed = inspectInstalled(native)
    if (
      sourceHash(imported) !== request.sourceHash ||
      sourceHash(installed.manifest.source) !== request.sourceHash ||
      sourceHash(installed.namespace) !== request.payload.nativeHash
    )
      fail("adoption belongs to another original namespace or native facet")
    StorageCheckpoint.guardImport(archive, tx, assert)
    const result = await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
    assert()
    return result
  }
  export async function withInstalled<T>(
    input: Parameters<typeof verify>[0] & { permit: HomeRestoration.InstallPermit; request: InstallationRequest },
    body: (installed: Installed) => Promise<T>,
  ): Promise<T> {
    FileAtomicWrite.assertSupported()
    const permit = input.permit
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const signal = input.signal
    const resources = input.resources && {
      directory: input.resources.directory,
      expected: StorageCheckpoint.Manifest.parse(input.resources.expected),
      namespaceDirectory: input.resources.namespaceDirectory,
    }
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const request = InstallationRequest.parse(structuredClone(input.request))
    const selected = HomeRestoration.describe(permit)
    if (selected.owner !== "organization" || selected.sourceHash !== sourceHash(source))
      fail("installation belongs to another namespace checkpoint or native owner")
    if (request.sourceHash !== sourceHash(source) || request.payload.nativeHash !== sourceHash(expected))
      fail("installation requires its original fixed native facet")
    assertSource(source, expected, request.payload.cohort)
    HomeRestoration.assertRequest(permit, request)
    const runtime = RuntimeContext.current()
    const home = runtime.host.home
    let active = true
    let database: Database.Descriptor | undefined
    let verifiedBackend = false
    const assert = () => {
      if (!active) fail("installation callback is closed")
      signal?.throwIfAborted()
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertRequest(permit, request)
      if (RuntimeContext.current() !== runtime || runtime.host.home !== home)
        fail("installation belongs to another Runtime")
      if (verifiedBackend) Database.assertTarget(database)
    }
    try {
      const verified = await verify({ directory, expected, source, keys, signal, resources })
      assert()
      const { rawConfiguration, ...metadata } = verified
      const manifest = Manifest.parse(metadata)
      database = manifest.startup.database
      verifiedBackend = true
      Database.assertTarget(database)
      if (
        manifest.resources
          ? request.payload.resourcesHash !== sourceHash(manifest.resources)
          : request.payload.resourcesHash !== undefined
      )
        fail("installation requires its exact complete resource facet")
      if (JSON.stringify(manifest.identity) !== JSON.stringify(request.payload.cohort.source))
        fail("installation belongs to another original cohort participant")
      const ownership = await OrganizationServiceHome.installOwner(permit, manifest.owner)
      assert()
      let current = await readOrganizationConfigurationSnapshot(home, { signal })
      assert()
      const matches = (value: typeof current) =>
        value.present === manifest.configuration.present &&
        (!value.present ||
          (value.bytes.byteLength === manifest.configuration.raw?.bytes &&
            hash(value.bytes) === manifest.configuration.raw.sha256))
      if (!current.present && rawConfiguration) {
        current = await readOrganizationConfigurationSnapshot(home, { signal })
        assert()
        if (!current.present) {
          await FileAtomicWrite.withRoot(runtime.host.root, async (root) => {
            await HomeRestoration.verifyCurrent(permit)
            assert()
            await FileAtomicWrite.write(root, ["config", "synergy.d", ORGANIZATION_CONFIG_FILENAME], rawConfiguration)
            assert()
          })
          await HomeRestoration.verifyCurrent(permit)
          assert()
        } else if (!matches(current)) fail("target configuration conflicts with the fixed native material")
      } else if (!matches(current)) fail("target configuration conflicts with the fixed native material")
      const validate = async () => {
        assert()
        await HomeRestoration.verifyCurrent(permit)
        assert()
        await HomeOwnershipFile.open({ root: runtime.host.root, env: runtime.host.env, selected: ownership }).assert({
          required: true,
        })
        assert()
        if (!matches(await readOrganizationConfigurationSnapshot(home, { signal })))
          fail("installed configuration changed")
        assert()
      }
      await validate()
      const finish = async (resource?: Resources.Installed) => {
        const assertComplete = () => {
          assert()
          if (manifest.resources) {
            if (!resource) fail("installation requires original prepared resource bytes")
            Resources.assertInstalled(resource)
          }
        }
        const validateComplete = async () => {
          assertComplete()
          await validate()
          assertComplete()
        }
        const installed: Installed = Object.freeze({
          manifest: Manifest.parse(manifest),
          ownership: Object.freeze({ ...ownership }),
          assertCurrent: assertComplete,
          verify: validateComplete,
        })
        installations.set(installed, {
          assert: assertComplete,
          verify: validateComplete,
          manifest: Manifest.parse(manifest),
          namespace: StorageCheckpoint.Manifest.parse(expected),
        })
        const result = await body(installed)
        await validateComplete()
        return result
      }
      if (manifest.resources) {
        if (!resources) fail("installation requires its original resource facet")
        return await Resources.withInstalled({ ...resources, source, keys, signal, permit, request }, finish)
      }
      return await finish()
    } finally {
      active = false
    }
  }
}

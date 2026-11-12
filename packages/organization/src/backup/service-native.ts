import fs from "node:fs/promises"
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
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"

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
        ...(options.database ? ["database-target"] : []),
        ...(options.cloud && Object.values(options.cloud).some((value) => value && Object.keys(value).length)
          ? ["cloud-composition"]
          : []),
      ],
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
    if (startup.requirements.length) fail("requires a target reconstruction owner for its external composition")
    const runtime = RuntimeContext.current()
    const primary = runtime.storage
    const assert = () => {
      signal?.throwIfAborted()
      SnapshotMaintenance.assertArchive(archive)
      if (RuntimeContext.current() !== runtime || runtime.storage !== primary || state().startup !== startup)
        fail("requires its original startup and primary storage")
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
    if (owner.owner !== "organization" || owner.readerContract !== OrganizationServiceHome.readerContract)
      fail("requires the owning service Home reader")
    const root = runtime.host.root
    if (root !== path.join(runtime.host.home, ".synergy")) fail("requires its canonical native Home")
    const configuration = await readOrganizationConfigurationSnapshot(runtime.host.home, { signal })
    assert()
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
    })
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
      return { directory, namespace }
    } finally {
      await store?.close()
      await fs.rm(temporary, { recursive: true, force: true })
      if (published && !complete) await fs.rm(directory, { recursive: true, force: true })
    }
  }
  export async function verify(input: {
    directory: string
    expected: StorageCheckpoint.Manifest
    source: StorageCheckpoint.Manifest
    keys: VaultKeyProvider
    signal?: AbortSignal
  }): Promise<Manifest & { rawConfiguration?: Uint8Array }> {
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const signal = input.signal
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
    if (manifest.startup.requirements.length) fail("segment requires its owning service composition")
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
    const namespaceID = hash(Buffer.from(JSON.stringify({ kind: "service", ...cohort.source })))
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
    }),
  })
  export type InstallationRequest = z.infer<typeof InstallationRequest>
  export function installationRequest(input: {
    restoreID: string
    source: StorageCheckpoint.Manifest
    expected: StorageCheckpoint.Manifest
    snapshot: StorageCheckpoint.Manifest
    cohort: z.infer<typeof CohortMapping>
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
    const permit = input.permit
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const signal = input.signal
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
    const assert = () => {
      if (!active) fail("installation callback is closed")
      signal?.throwIfAborted()
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertRequest(permit, request)
      if (RuntimeContext.current() !== runtime || runtime.host.home !== home)
        fail("installation belongs to another Runtime")
    }
    try {
      const verified = await verify({ directory, expected, source, keys, signal })
      assert()
      const { rawConfiguration, ...metadata } = verified
      const manifest = Manifest.parse(metadata)
      if (JSON.stringify(manifest.identity) !== JSON.stringify(request.payload.cohort.source))
        fail("installation belongs to another original cohort participant")
      const ownership = await OrganizationServiceHome.installOwner(permit)
      assert()
      const filename = path.join(home, ".synergy", "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME)
      let current = await readOrganizationConfigurationSnapshot(home, { signal })
      assert()
      const matches = (value: typeof current) =>
        value.present === manifest.configuration.present &&
        (!value.present ||
          (value.bytes.byteLength === manifest.configuration.raw?.bytes &&
            hash(value.bytes) === manifest.configuration.raw.sha256))
      if (!current.present && rawConfiguration) {
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
        assert()
        current = await readOrganizationConfigurationSnapshot(home, { signal })
        assert()
        if (!current.present) {
          await AtomicFile.writeFileAtomic(filename, rawConfiguration, { private: true, durable: true })
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
      const installed: Installed = Object.freeze({
        manifest: Manifest.parse(manifest),
        ownership: Object.freeze({ ...ownership }),
        assertCurrent: assert,
        verify: validate,
      })
      installations.set(installed, {
        assert,
        verify: validate,
        manifest: Manifest.parse(manifest),
        namespace: StorageCheckpoint.Manifest.parse(expected),
      })
      const result = await body(installed)
      await validate()
      return result
    } finally {
      active = false
    }
  }
}

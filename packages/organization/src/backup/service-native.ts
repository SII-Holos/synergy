import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { withStorageQueueOptions } from "@ericsanchezok/synergy-harness/storage/queue"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { Global } from "@ericsanchezok/synergy-harness/global"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"
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
    if (
      manifest.owner.owner !== "organization" ||
      manifest.owner.readerContract !== OrganizationServiceHome.readerContract ||
      manifest.startup.requirements.length
    )
      fail("segment requires its owning service composition")
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
}

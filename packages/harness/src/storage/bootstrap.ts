import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { AtomicFile } from "./atomic-file"
import { StoragePortable } from "./portable"
import { StorageConfiguration, readStorageConfiguration, resolveStoreOptions } from "./config"
import { StorageIntegrityError } from "./errors"
import { LegacyJsonImporter, legacySources, legacyRecordKey, type ImportProgress } from "./legacy-import"
import { TransactionalStore } from "./transactional-store"
import type { StoreOptions } from "./sql-contract"

const Manifest = z
  .object({
    version: z.literal(1),
    namespace: z.string(),
    backend: z.enum(["sqlite", "postgres"]),
    target: z.string(),
    artifactStoreID: z.uuid(),
    storeID: z.uuid().optional(),
    backupID: z.uuid(),
    phase: z.enum(["importing", "validating", "activating", "active"]),
  })
  .strict()

const Switch = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    configuration: StorageConfiguration,
    manifest: Manifest,
    archive: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

type Manifest = z.infer<typeof Manifest>

function targetIdentity(options: StoreOptions) {
  let target: string
  if (options.backend === "sqlite") target = path.resolve(options.filename)
  else {
    const url = new URL(options.url)
    target = JSON.stringify([url.hostname, url.port || "5432", url.pathname])
  }
  return createHash("sha256")
    .update(JSON.stringify([options.backend, options.namespace, target]))
    .digest("hex")
}

async function optionalJson(filename: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as unknown
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

async function rejectLegacyWriters(dataRoot: string) {
  for await (const entry of legacySources(dataRoot)) {
    if (legacyRecordKey(entry.relative))
      throw new StorageIntegrityError(
        "Legacy JSON records appeared after database activation; preserve both datasets and resolve the old writer before starting",
      )
  }
}

export namespace StorageBootstrap {
  export async function status(root: string) {
    const saved = await optionalJson(path.join(root, "data", "storage", "manifest.json"))
    return saved === undefined ? undefined : Manifest.parse(saved)
  }

  export type Prepared = Awaited<ReturnType<typeof prepare>>

  export async function inspect(root: string) {
    if (await optionalJson(path.join(root, "data", "storage", "switch.json")))
      throw new StorageIntegrityError("An interrupted storage switch requires data storage resume")
    const saved = await optionalJson(path.join(root, "data", "storage", "manifest.json"))
    if (saved === undefined) return
    const manifest = Manifest.parse(saved)
    if (manifest.phase !== "active")
      throw new StorageIntegrityError("Authoritative storage migration must finish before opening a read-only Handle")
    const options = resolveStoreOptions(root, await readStorageConfiguration(root), manifest.namespace)
    if (targetIdentity(options) !== manifest.target)
      throw new StorageIntegrityError("Storage configuration does not identify the active dataset")
    const store = await TransactionalStore.open({ ...options, readonly: true, mustExist: true })
    try {
      const identity = await store.read<{ storeID: string; artifactStoreID: string }>(["storage_meta", "identity"])
      if (identity.storeID !== manifest.storeID || identity.artifactStoreID !== manifest.artifactStoreID)
        throw new StorageIntegrityError("Database and artifacts belong to different datasets")
      return { store, artifactDirectory: path.join(root, "data"), manifest }
    } catch (error) {
      await store.close()
      throw error
    }
  }

  export async function migrateTarget(input: {
    root: string
    store: TransactionalStore
    configuration: StorageConfiguration
  }) {
    const directory = path.join(input.root, "data", "storage")
    if (await optionalJson(path.join(directory, "switch.json")))
      throw new StorageIntegrityError("Resume the interrupted storage switch before starting another")
    const manifest = Manifest.parse(await optionalJson(path.join(directory, "manifest.json")))
    if (manifest.phase !== "active" || manifest.namespace !== input.store.options.namespace)
      throw new StorageIntegrityError("Storage must be active before migrating its target")
    const configuration = StorageConfiguration.parse(input.configuration)
    const namespace = configuration.namespace ?? manifest.namespace
    const options = resolveStoreOptions(input.root, configuration, namespace)
    const target = targetIdentity(options)
    if (target === manifest.target) throw new StorageIntegrityError("The requested target is already active")
    const id = randomUUID()
    const archive = path.join(directory, "transfers", id, "source.ndjson")
    await StoragePortable.exportFile(input.store, archive)
    const sha256 = await fileDigest(archive)
    const next = { ...manifest, namespace, backend: options.backend, target }
    await AtomicFile.writeJsonAtomic(
      path.join(directory, "switch.json"),
      JSON.stringify({
        version: 1,
        id,
        configuration,
        manifest: next,
        archive: path.relative(directory, archive),
        sha256,
      }),
      { private: true, durable: true },
    )
    await resumeTargetSwitch(input.root)
  }

  export async function resumeTargetSwitch(root: string) {
    const directory = path.join(root, "data", "storage")
    const filename = path.join(directory, "switch.json")
    const raw = await optionalJson(filename)
    if (!raw) return false
    const intent = Switch.parse(raw)
    const archive = path.resolve(directory, intent.archive)
    if (!archive.startsWith(directory + path.sep) || (await fileDigest(archive)) !== intent.sha256)
      throw new StorageIntegrityError("Storage transfer backup checksum failed")
    const options = resolveStoreOptions(root, intent.configuration, intent.manifest.namespace)
    if (targetIdentity(options) !== intent.manifest.target)
      throw new StorageIntegrityError("Storage transfer target identity changed")
    const store = await TransactionalStore.open({ ...options, recover: true })
    try {
      const completed = await store.operationReceipt(intent.id)
      if (!completed && (await store.query({ limit: 1 })).length)
        throw new StorageIntegrityError("Storage target is not empty; choose a new namespace or database")
      await StoragePortable.importFile(store, archive, { operationID: intent.id })
      const report = await store.verify()
      if (report.issues.length) throw new StorageIntegrityError("Transferred data failed relationship verification")
      const identity = await store.read<{ storeID: string; artifactStoreID: string }>(["storage_meta", "identity"])
      if (identity.storeID !== intent.manifest.storeID || identity.artifactStoreID !== intent.manifest.artifactStoreID)
        throw new StorageIntegrityError("Transferred database identity differs from its artifacts")
    } finally {
      await store.close()
    }
    await AtomicFile.writeJsonAtomic(
      path.join(root, "config", "synergy.d", "130-storage.jsonc"),
      JSON.stringify({ storage: intent.configuration }),
      { private: true, durable: true },
    )
    await AtomicFile.writeJsonAtomic(path.join(directory, "manifest.json"), JSON.stringify(intent.manifest), {
      private: true,
      durable: true,
    })
    await fs.unlink(filename)
    return true
  }

  export async function prepare(options: {
    root: string
    recover?: boolean
    progress?: (progress: ImportProgress) => void
  }) {
    const root = path.resolve(options.root)
    if (await optionalJson(path.join(root, "data", "storage", "switch.json")))
      throw new StorageIntegrityError("An interrupted storage switch requires data storage resume")
    const directory = path.join(root, "data", "storage")
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    return withFileLock({ directory: path.join(directory, ".locks"), key: "bootstrap" }, async () => {
      const filename = path.join(directory, "manifest.json")
      const saved = await optionalJson(filename)
      const configuration = await readStorageConfiguration(root)
      const namespace = saved ? Manifest.parse(saved).namespace : (configuration.namespace ?? randomUUID())
      const storeOptions = resolveStoreOptions(root, configuration, namespace)
      const target = targetIdentity(storeOptions)
      const manifest: Manifest = saved
        ? Manifest.parse(saved)
        : {
            version: 1,
            namespace,
            backend: storeOptions.backend,
            target,
            artifactStoreID: randomUUID(),
            backupID: randomUUID(),
            phase: "importing",
          }
      if (manifest.target !== target || manifest.backend !== storeOptions.backend)
        throw new StorageIntegrityError(
          "Storage configuration points away from the active dataset; use an explicit storage migration",
        )
      const persist = () =>
        AtomicFile.writeJsonAtomic(filename, JSON.stringify(manifest), { private: true, durable: true })
      if (!saved) await persist()
      const store = await TransactionalStore.open({
        ...storeOptions,
        recover: options.recover,
        mustExist: manifest.phase !== "importing",
      })
      try {
        const identityKey = ["storage_meta", "identity"]
        const [identity] = await store.readMany<{ storeID: string; artifactStoreID: string }>([identityKey])
        if (identity) {
          if (
            identity.artifactStoreID !== manifest.artifactStoreID ||
            (manifest.storeID && manifest.storeID !== identity.storeID)
          )
            throw new StorageIntegrityError("Database and local artifact storage belong to different datasets")
          manifest.storeID = identity.storeID
        } else {
          if (manifest.phase !== "importing" || manifest.storeID)
            throw new StorageIntegrityError("Active storage identity is missing")
          manifest.storeID = randomUUID()
          await store.write(identityKey, { storeID: manifest.storeID, artifactStoreID: manifest.artifactStoreID })
        }
        const importer = new LegacyJsonImporter({
          dataRoot: path.join(root, "data"),
          backupRoot: path.join(directory, "backups", manifest.backupID),
          store,
          progress: options.progress,
        })
        if (manifest.phase === "importing") {
          await importer.run()
          const archive = path.join(root, "data", "agent-records.ndjson")
          if (await Bun.file(archive).exists())
            await StoragePortable.importFile(store, archive, {
              operationID: `portable-${manifest.backupID}`,
              accept: (entry) =>
                entry.type !== "record" ||
                ![
                  "storage_meta",
                  "storage_import",
                  "storage_import_files",
                  "storage_staging",
                  "storage_transfer",
                ].includes(entry.key[0]),
            })
          manifest.phase = "validating"
          await persist()
        }
        if (manifest.phase === "active") await rejectLegacyWriters(path.join(root, "data"))
        const activate = async () => {
          if (manifest.phase === "active") return
          manifest.phase = "activating"
          await persist()
          await importer.retire()
          await rejectLegacyWriters(path.join(root, "data"))
          manifest.phase = "active"
          await persist()
        }
        if (manifest.phase === "activating") await activate()
        return { store, manifest, activate }
      } catch (error) {
        await store.close()
        throw error
      }
    })
  }
}

async function fileDigest(filename: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest("hex")
}

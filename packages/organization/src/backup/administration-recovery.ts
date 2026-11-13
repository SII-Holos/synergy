import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationBackupAdministration as Administration } from "./administration"
import { OrganizationCurrentAuthority as Current } from "./current-authority"
import { OrganizationSourceRetirement as Retirement } from "./source-retirement"
import { OrganizationRecovery as Recovery } from "./recovery"
import { OrganizationRecoveryPublication as Publication } from "./publication"
import { OrganizationRecoveryAuthority as Authority } from "./authority"
import { OrganizationRecoveryWriters as Writers } from "./writers"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationSourcePreparation as Preparation } from "./source-preparation"
import { readOrganizationPrivateFile } from "../private-file"
import { readOrganizationConfiguration } from "../configuration"
import { loadOrganizationInfrastructure } from "../infrastructure"
import {
  openOrganizationPendingRetirement,
  openOrganizationRecovery,
  openOrganizationService,
  openOrganizationSourcePreparation,
  openOrganizationSourceRetirement,
} from "../service"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const Selector = z.strictObject({
  version: z.literal(1),
  reference: Retirement.Reference,
  publicOrigin: z.string().url(),
})
const selectionName = "reference.json"
function exactOrigin(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("Recovery requires an exact HTTPS origin")
  return value
}
async function facet(work: string, name: string) {
  const directory = path.join(work, "h1", name)
  return {
    directory,
    expected: StorageCheckpoint.Manifest.parse(await Bun.file(path.join(directory, "manifest.json")).json()),
  }
}

export namespace OrganizationRecoveryAdministration {
  export async function recover(input: {
    home: string
    sourceHome: string
    directory: string
    work: string
    restoreID: string
    buildVersion: string
    publicOrigin: string
    sourceOrigin?: string
    keys: VaultKeyProvider
    signal?: AbortSignal
  }) {
    const selected = Object.freeze({
      ...input,
      keys: Object.freeze({
        current: input.keys.current.bind(input.keys),
        resolve: input.keys.resolve.bind(input.keys),
      }),
    })
    if (
      [selected.home, selected.sourceHome, selected.directory, selected.work].some((value) => !path.isAbsolute(value))
    )
      throw new Error("Recovery requires absolute original paths")
    const publicOrigin = exactOrigin(selected.publicOrigin)
    if (selected.sourceOrigin) exactOrigin(selected.sourceOrigin)
    const home = await fs.realpath(selected.home)
    const sourceHome = await fs.realpath(selected.sourceHome)
    const work = path.join(await fs.realpath(path.dirname(selected.work)), path.basename(selected.work))
    if (
      home === sourceHome ||
      [home, sourceHome].some((directory) => work === directory || work.startsWith(directory + path.sep))
    )
      throw new Error("Recovery requires independent absolute Source, Target and work paths")
    const sourceOwner = await HomeOwnershipFile.open({
      root: path.join(sourceHome, ".synergy"),
      env: process.env,
    }).read()
    if (!sourceOwner || sourceOwner.owner !== "organization" || sourceOwner.schemaVersion === 1)
      throw new Error("Recovery requires an existing original service Source Home; original data is retained")
    const signal = selected.signal
    const keys = Object.freeze({
      current: selected.keys.current.bind(selected.keys),
      resolve: selected.keys.resolve.bind(selected.keys),
    })
    const sourceOwners: Array<{ close(): Promise<void> }> = []
    await using sourceLifetime = {
      async [Symbol.asyncDispose]() {
        const outcomes = await Promise.allSettled(sourceOwners.map((source) => source.close()))
        const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
        if (errors.length) throw new AggregateError(errors, "Recovery source completion did not drain")
      },
    }
    FileAtomicWrite.assertSupported()
    const result = await Administration.withExistingTarget(
      { home, directory: selected.directory, restoreID: selected.restoreID, keys, signal },
      async (context) => {
        const existing = await fs.lstat(work).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
        if (
          existing &&
          (!existing.isDirectory() ||
            existing.isSymbolicLink() ||
            (process.platform !== "win32" && (existing.mode & 0o077) !== 0))
        )
          throw new Error("Recovery work must remain its original private directory; existing data is retained")
        if (!existing) await fs.mkdir(work, { mode: 0o700 })
        return withFileLock({ directory: path.join(work, ".locks"), key: "service-recovery", signal }, async () => {
          const selectorFile = path.join(work, selectionName)
          let selector: z.infer<typeof Selector> | undefined
          if (existing) {
            const selectedFile = await fs.lstat(selectorFile).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error
            })
            if (selectedFile) {
              try {
                selector = Selector.parse(JSON.parse(await readOrganizationPrivateFile(selectorFile)))
              } catch {
                throw new Error(
                  "Incomplete recovery work is retained; no source retirement was authorized by this command",
                )
              }
            }
            if (
              selector &&
              (selector.publicOrigin !== publicOrigin ||
                selector.reference.target.installationID !== context.info.installationID ||
                selector.reference.target.requestHash !== context.info.requestHash ||
                selector.reference.target.restoreID !== selected.restoreID ||
                selector.reference.target.sourceHash !== context.info.sourceHash ||
                selector.reference.target.incarnation !== context.info.incarnation ||
                selector.reference.target.nativeHash !== context.request.payload.nativeHash)
            )
              throw new Error(
                "Recovery work belongs to another original Target or origin; all original data is retained",
              )
          }
          const published = await Publication.readIfPresent(context.info.installationID)
          if (published) {
            if (
              !selector ||
              published.publicOrigin !== publicOrigin ||
              hash(published.source) !== hash(selector.reference)
            )
              throw new Error("Published recovery requires its same original durable Reference")
            const namespace = await facet(work, "records")
            const native = await facet(work, "native")
            if (
              Native.sourceHash(namespace.expected) !== selector.reference.current.namespaceHash ||
              Native.sourceHash(native.expected) !== selector.reference.current.nativeHash
            )
              throw new Error("Published recovery archives differ from the original Reference")
            const archived = await AuthorityJournal.readArchivedCheckpoint({
              ...namespace,
              keys,
              after: selector.reference.current.after,
              signal,
            })
            const fixed = await Native.verify({ ...native, source: namespace.expected, keys, signal })
            try {
              if (
                hash(archived) !== hash(selector.reference.current.checkpoint) ||
                hash(fixed.startup.settings.clientAuthentication.clients) !==
                  selector.reference.current.clientDefinitionsHash
              )
                throw new Error("Published recovery does not match its fixed H1 authority")
            } finally {
              fixed.rawConfiguration?.fill(0)
            }
            const source = await openOrganizationSourceRetirement({
              home: sourceHome,
              reference: selector.reference,
            })
            sourceOwners.push(source)
            await source.complete()
            return published
          }
          return context.withPrepared(async (original, target) => {
            const prepared = Authority.describe(original.prepared)
            const resume = async (saved: z.infer<typeof Selector>) => {
              const namespace = await facet(work, "records")
              const native = await facet(work, "native")
              const source = await openOrganizationPendingRetirement({
                home: sourceHome,
                reference: saved.reference,
              })
              sourceOwners.push(source)
              const receipt = await Current.resumeRetirement({
                source: source.source,
                target: original,
                namespace,
                native,
                keys,
                signal,
              })
              return await source.run(() =>
                Recovery.publishServiceOnly({ source: receipt, target, namespace, native, keys, publicOrigin, signal }),
              )
            }
            if (selector) return resume(selector)
            const saved = await Recovery.withPreparationTarget(target, (preparationTarget) =>
              Preparation.withOriginal(
                { target: preparationTarget, work, publicOrigin, sourceOrigin: selected.sourceOrigin, signal },
                async (preparation) => {
                  const configuration = await readOrganizationConfiguration(sourceHome)
                  await using source = await openOrganizationSourcePreparation({
                    ...configuration,
                    ...(await loadOrganizationInfrastructure(configuration.infrastructure)),
                    home: sourceHome,
                    publicOrigin: selected.sourceOrigin,
                    preparation,
                  })
                  return await source.run(() =>
                    Preparation.withLease(preparation, { existingWork: !!existing, signal }, async (lease, retain) => {
                      await Writers.assertServiceOnly({ signal })
                      return Current.withSource(
                        {
                          lease,
                          after: prepared.checkpoint,
                          directory: path.join(work, "h1"),
                          buildVersion: selected.buildVersion,
                          keys,
                          signal,
                        },
                        async (current) => {
                          await Recovery.preflightWriters({ source: current, target, signal })
                          const reference = await Current.retirementReference(current, prepared.reference)
                          const expected = Selector.parse({ version: 1, reference, publicOrigin })
                          retain()
                          await Preparation.verify(preparation)
                          return FileAtomicWrite.withRoot(work, async (root) => {
                            await Current.verify(current)
                            await Preparation.verify(preparation)
                            await FileAtomicWrite.write(
                              root,
                              [selectionName],
                              Buffer.from(JSON.stringify(expected) + "\n"),
                            )
                            await Preparation.verify(preparation)
                            await Current.verify(current)
                            const saved = Selector.parse(JSON.parse(await readOrganizationPrivateFile(selectorFile)))
                            if (hash(saved) !== hash(expected))
                              throw new Error("Original recovery selector was replaced")
                            return saved
                          })
                        },
                      )
                    }),
                  )
                },
              ),
            )
            return resume(saved)
          })
        })
      },
    )
    await using completion = await openOrganizationRecovery({ home })
    await completion.run(() => Recovery.completeServicePublication(result.target.installationID))
    await completion.run(() => HomeRestoration.assertOrdinaryStartup())
    await completion.close()
    await using ordinary = await openOrganizationService({ home })
    const deployment = await ordinary.deployment()
    if (
      deployment.orgID !== result.identity.orgID ||
      deployment.deploymentIncarnation !== result.target.incarnation ||
      (await ordinary.fetch(new Request(publicOrigin + "/org/v1/ready"))).status !== 200
    )
      throw new Error("Recovery publication remains retained; ordinary service readiness was not verified")
    return {
      state: "ready" as const,
      executionEnabled: false,
      restoreID: result.target.restoreID,
      installationID: result.target.installationID,
      incarnation: result.target.incarnation,
      orgID: deployment.orgID,
      publicOrigin,
    }
  }
}

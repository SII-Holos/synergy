import { createHash } from "node:crypto"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationSourceRetirement as Retirement } from "./source-retirement"
import { OrganizationRecoveryAuthority as Authority } from "./authority"
import { OrganizationRecoveryWriters as Writers } from "./writers"
import { readOrganizationConfigurationSnapshot } from "../configuration"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fail(message: string): never {
  throw new Error("Pending source retirement " + message)
}

export namespace OrganizationPendingSource {
  export interface Source {
    readonly kind: "pending-organization-source"
  }
  const sources = new WeakMap<
    Source,
    { reference: Retirement.Reference; runtime: RuntimeContext.Instance; assert(): void }
  >()
  const pending = RuntimeContext.state(() => new Set<Promise<unknown>>())
  const admissions = new WeakMap<object, { reference: Retirement.Reference; assert(): void }>()
  export function register() {
    RuntimeMaintenance.registerRetirementSource("organization-service", {
      inspect(evidence) {
        const admission = admissions.get(evidence)
        if (!admission) fail("requires its actual verified fixed H1 admission")
        admission.assert()
        return {
          source: admission.reference.current.maintenance,
          marker: Retirement.marker(admission.reference),
          configurationHash: admission.reference.primaryConfigHash,
        }
      },
    })
  }
  export function create(value: Retirement.Reference): Source {
    const reference = Retirement.Reference.parse(structuredClone(value))
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const configuration = hash(store.options)
    const artifacts = primary.artifactDirectory
    const assert = () => {
      if (
        runtime.storage !== primary ||
        primary.store !== store ||
        hash(store.options) !== configuration ||
        primary.artifactDirectory !== artifacts ||
        primary.artifactObjects ||
        !store.readiness.readerReady
      )
        fail("original source primary is closed or changed")
    }
    assert()
    const source = Object.freeze({ kind: "pending-organization-source" as const })
    sources.set(source, { reference, runtime, assert })
    return source
  }
  export function resume(input: {
    source: Source
    target: {
      permit: HomeRestoration.InstallPermit
      request: Native.InstallationRequest
      native: Native.Installed
      prepared: Authority.Prepared
    }
    namespace: { directory: string; expected: StorageCheckpoint.Manifest }
    native: { directory: string; expected: StorageCheckpoint.Manifest }
    keys: VaultKeyProvider
    signal?: AbortSignal
  }): Promise<Retirement.Receipt> {
    const source = sources.get(input.source)
    if (!source) fail("requires its original restricted source")
    source.assert()
    const targetRuntime = RuntimeContext.current()
    const primary = Storage.current()
    const config = hash(primary.store.options)
    const target = { ...input.target, request: Native.InstallationRequest.parse(structuredClone(input.target.request)) }
    const namespace = {
      directory: input.namespace.directory,
      expected: StorageCheckpoint.Manifest.parse(input.namespace.expected),
    }
    const native = {
      directory: input.native.directory,
      expected: StorageCheckpoint.Manifest.parse(input.native.expected),
    }
    const keys = Object.freeze({
      current: input.keys.current.bind(input.keys),
      resolve: input.keys.resolve.bind(input.keys),
    })
    const signal = input.signal
    const reference = source.reference
    let open = true
    const assertNative = () => {
      source.assert()
      if (
        !open ||
        targetRuntime.storage !== primary ||
        hash(primary.store.options) !== config ||
        !primary.store.readiness.readerReady
      )
        fail("original Target callback or primary changed")
    }
    const assert = () => {
      signal?.throwIfAborted()
      assertNative()
    }
    const verifyTarget = (inventory = true) =>
      targetRuntime.run(async () => {
        assert()
        HomeRestoration.assertRequest(target.permit, target.request)
        HomeRestoration.assertInstalledOwner(target.permit)
        await Native.verifyInstalled(target.native)
        await Authority.verify(target.prepared)
        const prepared = Authority.describe(target.prepared)
        if (
          hash(prepared.reference) !== hash(reference.target) ||
          !reference.current.after ||
          hash(prepared.checkpoint) !== hash(reference.current.after)
        )
          fail("another original Target or H0 anchor")
        if (inventory)
          await Writers.preflight({
            permit: target.permit,
            request: target.request,
            target: reference.target,
            base: target.native.manifest.source,
            namespace,
            keys,
            signal,
          })
        assert()
      })
    let completed: Retirement.Receipt | undefined
    const work = (async () => {
      try {
        if (
          Native.sourceHash(namespace.expected) !== reference.current.namespaceHash ||
          Native.sourceHash(native.expected) !== reference.current.nativeHash
        )
          fail("fixed H1 archive selector changed")
        await verifyTarget()
        return await source.runtime.run(async () => {
          assert()
          const fixed = await Native.verify({ ...native, source: namespace.expected, keys, signal })
          try {
            const configuration = await readOrganizationConfigurationSnapshot(source.runtime.host.home, { signal })
            try {
              if (
                configuration.present !== fixed.configuration.present ||
                hash(configuration.settings) !== hash(fixed.configuration.settings) ||
                (fixed.configuration.raw &&
                  createHash("sha256").update(configuration.bytes).digest("hex") !== fixed.configuration.raw.sha256) ||
                hash(fixed.startup.settings.clientAuthentication.clients) !== reference.current.clientDefinitionsHash
              )
                fail("actual native H1 settings changed")
            } finally {
              configuration.bytes.fill(0)
            }
            const archived = await AuthorityJournal.readArchivedCheckpoint({
              ...namespace,
              keys,
              after: reference.current.after,
              signal,
            })
            const live = await AuthorityJournal.inspect()
            if (
              !live.covered ||
              !live.head ||
              fixed.identity.orgID !== live.head.namespaceID ||
              hash(live.head) !== hash(reference.current.checkpoint) ||
              hash(archived) !== hash(live.head)
            )
              fail("fixed H1 is not the actual covered source")
            assert()
            if (await RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)) {
              completed = await Retirement.complete(reference)
              return completed
            }
            await compareNamespace(namespace, keys, assert, signal)
            await verifyTarget()
            const admission = Object.freeze({ kind: "verified-pending-source" })
            admissions.set(admission, { reference, assert: assertNative })
            return RuntimeMaintenance.withRetirementSource({ evidence: admission, signal }, (lease) =>
              RuntimeMaintenance.withFrozen(
                lease,
                () =>
                  targetRuntime.run(() =>
                    Writers.withPreflight(
                      {
                        permit: target.permit,
                        request: target.request,
                        target: reference.target,
                        base: target.native.manifest.source,
                        namespace,
                        keys,
                        signal,
                      },
                      () =>
                        source.runtime.run(async () => {
                          await verifyTarget(false)
                          const actual = await Retirement.reference(reference.current, reference.target)
                          if (hash(actual) !== hash(reference)) fail("original physical Source reference changed")
                          assert()
                          const referenceHash = Retirement.marker(reference).referenceHash
                          return RuntimeMaintenance.withRetirementCommit({ lease, referenceHash }, async () => {
                            completed = await Retirement.complete(reference)
                            return completed
                          })
                        }),
                    ),
                  ),
                { signal },
              ),
            )
          } finally {
            fixed.rawConfiguration?.fill(0)
          }
        })
      } finally {
        open = false
      }
    })().catch((error: unknown) => {
      if (completed && signal?.aborted && error === signal.reason) return completed
      throw error
    })
    const accepted = source.runtime.run(pending)
    accepted.add(work)
    void work.then(
      () => accepted.delete(work),
      () => accepted.delete(work),
    )
    return work
  }
  export async function drain() {
    const outcomes = await Promise.allSettled([...pending()])
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Accepted pending source recovery did not finish")
  }
  async function compareNamespace(
    namespace: { directory: string; expected: StorageCheckpoint.Manifest },
    keys: VaultKeyProvider,
    assert: () => void,
    signal?: AbortSignal,
  ) {
    try {
      await SnapshotMaintenance.compareNamespace(namespace, keys, assert, signal)
    } catch (error) {
      if (error instanceof SnapshotMaintenance.NamespaceMismatch) fail(error.message)
      throw error
    }
  }
}

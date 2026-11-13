import { createHash } from "node:crypto"
import type { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationCurrentAuthority as Current } from "./current-authority"
import { OrganizationRecoveryAuthority as Authority } from "./authority"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationSourceRetirement as Retirement } from "./source-retirement"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationRecoveryPublication as Publication } from "./publication"
import { OrganizationRecoveryWriters } from "./writers"
import { OrganizationCurrentPolicyReceipt as Receipt, currentPolicyKey as key } from "./policy-records"
import type { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fail(message: string): never {
  throw new Error("Organization current-policy recovery " + message)
}
type TargetBinding = {
  assert(): void
  assertLive(): void
  verify(): Promise<void>
  run<T>(body: () => T): T
  request: Native.InstallationRequest
  permit: HomeRestoration.InstallPermit
  reference: z.infer<typeof OrganizationInstallationReference>
  checkpoint: AuthorityJournal.Checkpoint
  base: StorageCheckpoint.Manifest
  prepared: Authority.Prepared
}

export namespace OrganizationRecovery {
  export interface Target {
    readonly kind: "organization-recovery-policy-target"
  }
  const targets = new WeakMap<Target, TargetBinding>()
  export interface PreparationTarget {
    readonly kind: "organization-source-preparation-target"
  }
  const preparations = new WeakMap<
    PreparationTarget,
    {
      assert(): void
      verify(): Promise<void>
      reference: z.infer<typeof OrganizationInstallationReference>
      checkpoint: AuthorityJournal.Checkpoint
    }
  >()
  function preparation(target: PreparationTarget) {
    const selected = preparations.get(target)
    if (!selected) fail("preparation requires its original live Target evidence")
    selected.assert()
    return selected
  }
  export function assertPreparationTarget(target: PreparationTarget) {
    preparation(target)
  }
  export function inspectPreparationTarget(target: PreparationTarget) {
    const selected = preparation(target)
    return {
      reference: OrganizationInstallationReference.parse(selected.reference),
      checkpoint: AuthorityJournal.Checkpoint.parse(selected.checkpoint),
    }
  }
  export async function verifyPreparationTarget(target: PreparationTarget) {
    if (Storage.inTransaction()) fail("preparation Target verification requires its boundary outside Source SQL")
    await preparation(target).verify()
  }
  export async function withPreparationTarget<T>(target: Target, body: (target: PreparationTarget) => Promise<T>) {
    if (Storage.inTransaction()) fail("preparation Target capture requires its boundary outside Source SQL")
    const selected = targets.get(target)
    if (!selected) fail("preparation requires its original Target callback")
    const writer = await selected.run(async () => {
      await selected.verify()
      return ServerProcessLock.currentOwnership()
    })
    let open = true
    const assert = () => {
      if (!open || targets.get(target) !== selected) fail("preparation Target callback has ended")
      selected.assertLive()
      ServerProcessLock.assertLive(writer)
    }
    const verify = async () => {
      if (Storage.inTransaction()) fail("preparation Target verification requires its boundary outside Source SQL")
      assert()
      await selected.run(async () => {
        await ServerProcessLock.verifyOwnership(writer)
        await selected.verify()
        await ServerProcessLock.verifyOwnership(writer)
      })
      assert()
    }
    try {
      await verify()
      const cap: PreparationTarget = Object.freeze({ kind: "organization-source-preparation-target" })
      preparations.set(cap, { assert, verify, reference: selected.reference, checkpoint: selected.checkpoint })
      const result = await body(cap)
      await verify()
      return result
    } finally {
      open = false
    }
  }
  async function apply(
    target: TargetBinding,
    evidence: AuthorityJournal.Adoption,
    reference: Retirement.Reference,
    assert: () => void,
    signal?: AbortSignal,
  ) {
    const checkpoint = AuthorityJournal.describeAdoption(evidence)
    if (hash(checkpoint) !== hash(reference.current.checkpoint))
      fail("prepared policy has another final authority checkpoint")
    return RuntimeMaintenance.restorationTransaction(
      { permit: target.permit, request: target.request },
      async (tx) => {
        assert()
        const address = key(target.reference.installationID)
        const [value] = await tx.readMany([address])
        if (value !== undefined) {
          const receipt = Receipt.parse(value)
          if (
            hash(receipt.target) !== hash(target.reference) ||
            hash(receipt.source) !== hash(reference) ||
            hash(receipt.checkpoint) !== hash(checkpoint)
          )
            fail("publication receipt belongs to another original recovery")
          await AuthorityJournal.adopt(tx, evidence)
          assert()
          await OrganizationRecoveryWriters.publishKnowledgeDelta(tx)
          await OrganizationRecoveryWriters.sealPreflight(tx)
          return receipt
        }
        await AuthorityJournal.adopt(tx, evidence)
        assert()
        await OrganizationRecoveryWriters.publishKnowledgeDelta(tx)
        const receipt = Receipt.parse({
          version: 1,
          target: target.reference,
          source: reference,
          checkpoint,
          appliedAt: Date.now(),
        })
        await tx.write(address, receipt)
        await OrganizationRecoveryWriters.sealPreflight(tx)
        return receipt
      },
      { signal, commitGuard: assert },
    )
  }
  export async function withTarget<T>(
    input: {
      permit: HomeRestoration.InstallPermit
      native: Native.Installed
      prepared: Authority.Prepared
      request: Native.InstallationRequest
    },
    body: (target: Target) => Promise<T>,
  ) {
    const permit = input.permit
    const native = input.native
    const prepared = input.prepared
    const request = Native.InstallationRequest.parse(structuredClone(input.request))
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const configuration = hash(store.options)
    const artifacts = primary.artifactDirectory
    const objects = primary.artifactObjects
    const ports = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
    let open = true
    const assertLive = () => {
      if (!open) fail("target callback has ended")
      if (
        runtime.storage !== primary ||
        primary.store !== store ||
        !store.readiness.readerReady ||
        hash(store.options) !== configuration ||
        primary.artifactDirectory !== artifacts ||
        primary.artifactObjects !== objects ||
        objects?.blobs !== ports?.blobs ||
        objects?.writerID !== ports?.writerID ||
        objects?.now !== ports?.now
      )
        fail("requires its original target Runtime and primary Store")
    }
    const assert = () => {
      assertLive()
      const active = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        active.store !== store ||
        active.artifactDirectory !== artifacts ||
        active.artifactObjects !== objects
      )
        fail("requires its original target Runtime and primary Store")
      HomeRestoration.assertRequest(permit, request)
      HomeRestoration.assertInstalledOwner(permit)
      Native.assertInstalled(native)
      Authority.assertPrepared(prepared)
    }
    const verify = async () => {
      assert()
      await Native.verifyInstalled(native)
      await Authority.verify(prepared)
      assert()
    }
    try {
      await verify()
      const info = Authority.describe(prepared)
      const selected = HomeRestoration.describe(permit)
      const installed = Native.inspectInstalled(native)
      const reference = OrganizationInstallationReference.parse({
        installationID: selected.installationID,
        incarnation: selected.incarnation,
        restoreID: selected.restoreID,
        requestHash: selected.requestHash,
        sourceHash: selected.sourceHash,
        nativeHash: Native.sourceHash(installed.namespace),
      })
      if (
        hash(info.reference) !== hash(reference) ||
        request.sourceHash !== reference.sourceHash ||
        request.payload.nativeHash !== reference.nativeHash
      )
        fail("requires the same original installed target and prepared signer")
      const target: Target = Object.freeze({ kind: "organization-recovery-policy-target" })
      targets.set(target, {
        assert,
        assertLive,
        verify,
        run: runtime.run,
        permit,
        request,
        reference,
        checkpoint: info.checkpoint,
        base: StorageCheckpoint.Manifest.parse(native.manifest.source),
        prepared,
      })
      const result = await body(target)
      await verify()
      return result
    } finally {
      open = false
    }
  }
  export async function reconstruct(input: { source: Current.Source; target: Target; signal?: AbortSignal }) {
    const source = input.source
    const target = targets.get(input.target)
    const signal = input.signal
    if (!target) fail("requires its original target evidence")
    const sourceRuntime = RuntimeContext.current()
    const current = Current.describe(source)
    signal?.throwIfAborted()
    await target.run(target.verify)
    if (!current.after || hash(current.after) !== hash(target.checkpoint))
      fail("requires its actual original H0 checkpoint anchor")
    return Current.withCaptured(source, async (captured) => {
      const cancellation =
        signal && captured.signal ? AbortSignal.any([signal, captured.signal]) : (signal ?? captured.signal)
      const assert = () => {
        cancellation?.throwIfAborted()
        captured.assertLive()
        target.assert()
      }
      if (
        Native.sourceHash(captured.namespace.expected) !== current.namespaceHash ||
        Native.sourceHash(captured.native.expected) !== current.nativeHash
      )
        fail("captured policy belongs to another current source")
      return target.run(async () => {
        assert()
        return OrganizationRecoveryWriters.withPreflight(
          {
            permit: target.permit,
            request: target.request,
            target: target.reference,
            base: target.base,
            namespace: captured.namespace,
            keys: captured.keys,
            signal: cancellation,
          },
          async () => {
            assert()
            return AuthorityJournal.withAdoption(
              { ...captured.namespace, keys: captured.keys, after: target.checkpoint, signal: cancellation },
              async (evidence) => {
                assert()
                const checkpoint = AuthorityJournal.describeAdoption(evidence)
                if (hash(checkpoint) !== hash(current.checkpoint))
                  fail("prepared policy has another final authority checkpoint")
                const address = key(target.reference.installationID)
                const retained = await Storage.readMany([address]).then(([value]) =>
                  value === undefined ? undefined : Receipt.parse(value),
                )
                const reference =
                  retained?.source ??
                  (await sourceRuntime.run(() => Current.retirementReference(source, target.reference)))
                if (hash(reference.current) !== hash(current) || hash(reference.target) !== hash(target.reference))
                  fail("source reference belongs to another original target or current checkpoint")
                const retired = await sourceRuntime.run(() =>
                  retained ? Retirement.complete(reference) : Current.retire(source, reference),
                )
                await sourceRuntime.run(() => Retirement.verify(retired))
                cancellation?.throwIfAborted()
                await target.verify()
                return apply(target, evidence, reference, assert, cancellation)
              },
            )
          },
        )
      })
    })
  }
  export async function preflightWriters(input: { source: Current.Source; target: Target; signal?: AbortSignal }) {
    const source = input.source
    const target = targets.get(input.target)
    const signal = input.signal
    if (!target) fail("requires its original target evidence")
    const current = Current.describe(source)
    if (!current.after || hash(current.after) !== hash(target.checkpoint))
      fail("preflight requires its actual original H0 checkpoint anchor")
    return Current.withCaptured(source, (captured) =>
      target.run(async () => {
        const cancellation =
          signal && captured.signal ? AbortSignal.any([signal, captured.signal]) : (signal ?? captured.signal)
        cancellation?.throwIfAborted()
        captured.assertLive()
        await target.verify()
        await OrganizationRecoveryWriters.preflight({
          permit: target.permit,
          request: target.request,
          target: target.reference,
          base: target.base,
          namespace: captured.namespace,
          keys: captured.keys,
          signal: cancellation,
        })
        captured.assertLive()
        target.assert()
      }),
    )
  }
  export function completeServicePublication(installationID: string) {
    return Publication.complete(installationID)
  }
  export function publishServiceOnly(input: Parameters<typeof reconstructCold>[0] & { publicOrigin: string }) {
    return publish(input)
  }
  export function publishReconciled(
    input: Parameters<typeof reconstructCold>[0] & {
      publicOrigin: string
      writers: readonly NamespaceRetirement.Inspection[]
    },
  ) {
    return publish(input, [...input.writers])
  }
  async function publish(
    input: Parameters<typeof reconstructCold>[0] & { publicOrigin: string },
    writers?: readonly NamespaceRetirement.Inspection[],
  ) {
    const source = input.source
    const target = targets.get(input.target)
    if (!target) fail("requires its original target evidence")
    const publicOrigin = input.publicOrigin
    const origin = new URL(publicOrigin)
    if (origin.origin !== publicOrigin || origin.protocol !== "https:") fail("requires an explicit HTTPS public origin")
    const signal = input.signal
    const namespace = {
      directory: input.namespace.directory,
      expected: StorageCheckpoint.Manifest.parse(input.namespace.expected),
    }
    const native = {
      directory: input.native.directory,
      expected: StorageCheckpoint.Manifest.parse(input.native.expected),
      resources: input.native.resources && {
        ...input.native.resources,
        expected: StorageCheckpoint.Manifest.parse(input.native.resources.expected),
      },
    }
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    await reconstructCold({ source, target: input.target, namespace, native, keys, signal })
    return Retirement.withVerified(
      source,
      (inspection) =>
        target.run(async () => {
          const assert = () => {
            signal?.throwIfAborted()
            inspection.assertLive()
            target.assert()
          }
          const reference = Retirement.Reference.parse(inspection.reference)
          if (hash(reference.target) !== hash(target.reference))
            fail("publication source belongs to another original target")
          return Native.withPublicationSettings(
            { ...native, source: namespace.expected, keys, signal },
            async (settings) => {
              assert()
              const verified = Native.inspectPublicationSettings(settings)
              if (
                Native.sourceHash(namespace.expected) !== reference.current.namespaceHash ||
                Native.sourceHash(native.expected) !== reference.current.nativeHash ||
                hash(verified.manifest.startup.settings.clientAuthentication.clients) !==
                  reference.current.clientDefinitionsHash
              )
                fail("publication settings belong to another final source")
              await target.verify()
              const complete = (evidence?: OrganizationRecoveryWriters.Inspection) =>
                Authority.withActivation(target.prepared, (activation) =>
                  RuntimeMaintenance.restorationTransaction(
                    { permit: target.permit, request: target.request },
                    async (tx) => {
                      assert()
                      const policy = Receipt.parse(await Storage.read(key(target.reference.installationID)))
                      if (
                        hash(policy.source) !== hash(reference) ||
                        hash(policy.target) !== hash(target.reference) ||
                        hash(policy.checkpoint) !== hash(reference.current.checkpoint)
                      )
                        fail("requires its committed final current policy")
                      if (evidence) await OrganizationRecoveryWriters.assertReconciled(evidence)
                      else await OrganizationRecoveryWriters.assertServiceOnly({ signal })
                      assert()
                      const receipt = await Publication.write(tx, {
                        activation,
                        source: inspection,
                        native: settings,
                        publicOrigin,
                        writers: evidence,
                      })
                      if (!evidence) await OrganizationRecoveryWriters.sealPreflight(tx)
                      return receipt
                    },
                    { signal, commitGuard: assert },
                  ),
                )
              if (writers)
                return OrganizationRecoveryWriters.withReconciled(
                  {
                    permit: target.permit,
                    request: target.request,
                    target: target.reference,
                    base: target.base,
                    sources: writers,
                    namespace,
                    keys,
                    signal,
                  },
                  complete,
                )
              await OrganizationRecoveryWriters.assertServiceOnly({ signal })
              assert()
              return OrganizationRecoveryWriters.withPreflight(
                {
                  permit: target.permit,
                  request: target.request,
                  target: target.reference,
                  base: target.base,
                  namespace,
                  keys,
                  signal,
                },
                () => complete(),
              )
            },
          )
        }),
      { signal },
    )
  }
  export function reconstructCold(input: {
    source: Retirement.Receipt
    target: Target
    namespace: { directory: string; expected: StorageCheckpoint.Manifest }
    native: {
      directory: string
      expected: StorageCheckpoint.Manifest
      resources?: Parameters<typeof Native.verify>[0]["resources"]
    }
    keys: VaultKeyProvider
    signal?: AbortSignal
  }) {
    const source = input.source
    const target = targets.get(input.target)
    const namespace = {
      directory: input.namespace.directory,
      expected: StorageCheckpoint.Manifest.parse(input.namespace.expected),
    }
    const native = {
      directory: input.native.directory,
      expected: StorageCheckpoint.Manifest.parse(input.native.expected),
      resources: input.native.resources && {
        ...input.native.resources,
        expected: StorageCheckpoint.Manifest.parse(input.native.resources.expected),
      },
    }
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const signal = input.signal
    const sourceRuntime = RuntimeContext.current()
    if (!target) fail("requires its original target evidence")
    return Retirement.withVerified(
      source,
      async (inspection) => {
        const reference = Retirement.Reference.parse(inspection.reference)
        const current = reference.current
        const assert = () => {
          signal?.throwIfAborted()
          inspection.assertLive()
          target.assert()
        }
        if (
          hash(reference.target) !== hash(target.reference) ||
          !current.after ||
          hash(current.after) !== hash(target.checkpoint)
        )
          fail("cold source belongs to another original target or H0 anchor")
        if (
          Native.sourceHash(namespace.expected) !== current.namespaceHash ||
          Native.sourceHash(native.expected) !== current.nativeHash
        )
          fail("cold archives do not match the original retired source hashes")
        const verified = await Native.verify({ ...native, source: namespace.expected, keys, signal })
        try {
          if (
            verified.identity.orgID !== current.checkpoint.namespaceID ||
            hash(verified.startup.settings.clientAuthentication.clients) !== current.clientDefinitionsHash
          )
            fail("cold native settings do not match the original source")
        } finally {
          verified.rawConfiguration?.fill(0)
        }
        inspection.assertLive()
        return target.run(async () => {
          await target.verify()
          assert()
          return OrganizationRecoveryWriters.withPreflight(
            {
              permit: target.permit,
              request: target.request,
              target: target.reference,
              base: target.base,
              namespace,
              keys,
              signal,
            },
            () =>
              AuthorityJournal.withAdoption(
                { ...namespace, keys, after: target.checkpoint, signal },
                async (evidence) => {
                  assert()
                  if (hash(AuthorityJournal.describeAdoption(evidence)) !== hash(current.checkpoint))
                    fail("cold archive has another final authority checkpoint")
                  await sourceRuntime.run(() => Retirement.verify(source))
                  assert()
                  await target.verify()
                  return apply(target, evidence, reference, assert, signal)
                },
              ),
          )
        })
      },
      { signal },
    )
  }
}

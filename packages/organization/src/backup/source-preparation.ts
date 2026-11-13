import fs from "node:fs/promises"
import { constants, fstatSync, lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecovery as Recovery } from "./recovery"
import { OrganizationServiceHome } from "../service-home"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { loadSigningAuthority } from "../signing"
import { readOrganizationConfigurationSnapshot } from "../configuration"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fail(message: string): never {
  throw new Error("Source preparation " + message)
}

export namespace OrganizationSourcePreparation {
  export interface Original {
    readonly kind: "original-organization-source-preparation"
  }
  const originals = new WeakMap<
    Original,
    { assert(): void; verify(): Promise<void>; selectionHash: string; targetID: string }
  >()
  const state = RuntimeContext.state(() => ({ original: undefined as Original | undefined }))
  function original(value: Original) {
    const held = originals.get(value)
    if (!held) fail("requires its original Target and physical work owner")
    held.assert()
    return held
  }
  export async function withOriginal<T>(
    input: {
      target: Recovery.PreparationTarget
      work: string
      publicOrigin: string
      sourceOrigin?: string
      signal?: AbortSignal
    },
    body: (original: Original) => Promise<T>,
  ) {
    const { target, work, publicOrigin, sourceOrigin, signal } = input
    if (!path.isAbsolute(work) || (await fs.realpath(work)) !== work) fail("requires its exact canonical work path")
    const before = await fs.lstat(work, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077n) !== 0n)
      fail("requires its original private work directory")
    const directory = await fs.open(work, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    let open = true
    const assert = () => {
      signal?.throwIfAborted()
      if (!open) fail("physical work callback has ended")
      const physical = fstatSync(directory.fd, { bigint: true })
      const actual = lstatSync(work, { bigint: true })
      if (
        !physical.isDirectory() ||
        !actual.isDirectory() ||
        actual.isSymbolicLink() ||
        physical.dev !== before.dev ||
        physical.ino !== before.ino ||
        actual.dev !== before.dev ||
        actual.ino !== before.ino ||
        (actual.mode & 0o077n) !== 0n ||
        realpathSync(work) !== work
      )
        fail("lost its original physical work directory")
      Recovery.assertPreparationTarget(target)
    }
    const verify = async () => {
      if (Storage.inTransaction()) fail("must verify the original Target outside Source SQL")
      assert()
      await Recovery.verifyPreparationTarget(target)
      assert()
    }
    try {
      await verify()
      const selected = Recovery.inspectPreparationTarget(target)
      const cap: Original = Object.freeze({ kind: "original-organization-source-preparation" })
      originals.set(cap, {
        assert,
        verify,
        targetID: selected.reference.installationID,
        selectionHash: hash({
          version: 1,
          target: selected,
          work: { path: work, device: String(before.dev), inode: String(before.ino) },
          publicOrigin,
          sourceOrigin,
        }),
      })
      const result = await body(cap)
      await verify()
      return result
    } finally {
      open = false
      await directory.close()
    }
  }
  export async function selectOwner() {
    const runtime = RuntimeContext.current()
    const current = await HomeOwnershipFile.open({ root: runtime.host.root, env: runtime.host.env }).read()
    const owner = OrganizationServiceHome.archivedOwner(current)
    if (owner.schemaVersion !== 2) fail("requires its existing ordinary Service Home")
    HomeOwnership.select(owner)
    await HomeOwnership.assert({ required: true })
  }
  export function register(value: Original) {
    RuntimeContext.assertCompositionOpen("Organization Source preparation")
    if (state().original) fail("native owner is already registered")
    const held = original(value)
    state().original = value
    const assert = () => {
      if (state().original !== value) fail("requires its registered original owner")
      held.assert()
    }
    const capture = async (signal?: AbortSignal): Promise<RuntimeMaintenance.SourcePreparationSelection> => {
      assert()
      signal?.throwIfAborted()
      await held.verify()
      const source = OrganizationServiceHome.archivedOwner(await HomeOwnership.assert({ required: true }))
      const proof = await NativeNamespaceIdentity.capture()
      const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
      const signing = await loadSigningAuthority(deployment)
      const configuration = await readOrganizationConfigurationSnapshot(RuntimeContext.current().host.home, { signal })
      try {
        const selection = RuntimeMaintenance.SourcePreparationSelection.parse({
          version: 1,
          source,
          namespace: NativeNamespaceIdentity.inspect(proof),
          signingHash: hash(signing.identity),
          selectionHash: hash({
            intent: held.selectionHash,
            configuration: {
              present: configuration.present,
              hash: createHash("sha256").update(configuration.bytes).digest("hex"),
            },
          }),
        })
        await NativeNamespaceIdentity.verify(proof)
        await held.verify()
        assert()
        return selection
      } finally {
        configuration.bytes.fill(0)
      }
    }
    RuntimeMaintenance.registerSourcePreparationOwner("organization-service", {
      version: 1,
      assert,
      capture,
      async verify(expected, signal) {
        if (hash(await capture(signal)) !== hash(expected)) fail("original Source, Target or work selection changed")
      },
    })
  }
  export async function withLease<T>(
    value: Original,
    input: { existingWork: boolean; signal?: AbortSignal },
    body: (lease: RuntimeMaintenance.Lease, retain: () => void) => Promise<T>,
  ) {
    const held = original(value)
    if (state().original !== value) fail("requires its registered original preparation capability")
    const requestID =
      "source-preparation:" + hash({ installationID: held.targetID, source: RuntimeContext.current().host.home })
    const status = await RuntimeMaintenance.status()
    let retained = status?.version === 3 && status.requestID === requestID
    const capture = async (lease: RuntimeMaintenance.Lease) => {
      const operation = await RuntimeMaintenance.assertHeld(lease)
      if (operation.phase === "draining")
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease, { signal: input.signal }))
      return body(lease, () => {
        retained = true
      })
    }
    if (status?.version === 3 && status.requestID === requestID)
      return RuntimeMaintenance.withSourcePreparationRecovery({ requestID, signal: input.signal }, capture)
    if (input.existingWork) fail("Incomplete recovery work has no original native preparation witness")
    const lease = await RuntimeMaintenance.beginSourcePreparation({
      requestID,
      signal: input.signal,
      actor: {
        kind: "system",
        subjectID: "host-operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID,
      },
    })
    try {
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease, { signal: input.signal }))
      return await body(lease, () => {
        retained = true
      })
    } finally {
      if (!retained) await RuntimeMaintenance.release(lease)
    }
  }
  export async function verify(value: Original) {
    await original(value).verify()
  }
}

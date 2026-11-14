import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { prepareHostedHome, prepareMemberHome, runtimeIdentityDigest } from "../../src/home"
import { NativeHomeReaderContract } from "../../src/home-schema"
import { readCredentials } from "../../src/credentials"
import { registerOrganizationHomeMigration } from "../../src/home-migration"

type Home = Awaited<ReturnType<typeof prepareHostedHome>> | Awaited<ReturnType<typeof prepareMemberHome>>
const keys = (home: Home) =>
  fs
    .readFile(path.join(home.root, "auth", "organization-runtime.json"))
    .then((value) => createHash("sha256").update(value).digest("hex"))

export async function selectedHomeUpgradeOwner(
  home: Home,
  targetReader: string = NativeHomeReaderContract,
  register?: () => void,
) {
  const runtime = await storageTestRuntime({ home: home.home })
  const context = await runtime.run(() => RuntimeContext.current())
  let store: TransactionalStore | undefined
  let writer: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
  async function close() {
    const errors: unknown[] = []
    for (const stop of [
      () => context.run(() => store?.close()),
      () => context.run(() => writer?.release()),
      () => runtime.close(),
    ]) {
      try {
        await stop()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "Native Home reader fixture cleanup failed")
  }
  try {
    store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(home.root, "authority.sqlite"),
      namespace: "home-reader-sync",
    })
    context.storage = { store, artifactDirectory: path.join(home.root, "data") }
    await context.run(async () => {
      writer = await ServerProcessLock.acquire()
      const files = HomeOwnershipFile.open({ root: home.root, env: context.host.env })
      HomeOwnership.select(HomeOwnershipFile.FencedInfo.parse(await files.read()))
      async function namespace() {
        const credentials = await readCredentials(home.root)
        if (!credentials || credentials.publicKey !== home.publicKey) throw new Error("The actual native key changed")
        return {
          orgID: home.identity.orgID,
          identity: runtimeIdentityDigest(home.identity),
          publicKey: credentials.publicKey,
        }
      }
      NativeNamespaceIdentity.register({ owner: "organization-runtime", read: namespace })
      RuntimeMaintenance.configure({ required: ["native-home-writer"] })
      RuntimeMaintenance.register("native-home-writer", {
        version: 1,
        async suspend(current) {
          await RuntimeMaintenance.assertDraining(current.lease)
        },
        async drain(current) {
          await RuntimeMaintenance.assertDraining(current.lease)
        },
        async inspect() {
          return []
        },
        async reconcileFrozen(current) {
          await RuntimeMaintenance.assertNativeReconciliation(current.lease, "frozen")
        },
        async reconcileReleasing(current) {
          await RuntimeMaintenance.assertNativeReconciliation(current.lease, "releasing")
        },
        async release(current) {
          await RuntimeMaintenance.assertReleasing(current.lease)
        },
        async released(current) {
          await RuntimeMaintenance.assertReleased(current.lease)
        },
      })
      RuntimeMaintenance.registerHomeUpgradeOwner("native-home-writer", {
        version: 1,
        async capture() {
          const proof = await NativeNamespaceIdentity.capture()
          const source = HomeOwnershipFile.FencedInfo.parse(await files.read())
          const target = HomeOwnershipFile.FencedInfo.parse({ ...source, readerContract: targetReader })
          await NativeNamespaceIdentity.verify(proof)
          return {
            version: 1,
            source,
            target,
            namespace: NativeNamespaceIdentity.inspect(proof),
            signingHash: await keys(home),
          }
        },
        async verify(selection) {
          const actual = await files.read()
          if (
            (JSON.stringify(actual) !== JSON.stringify(selection.source) &&
              JSON.stringify(actual) !== JSON.stringify(selection.target)) ||
            selection.target.readerContract !== targetReader ||
            selection.target.owner !== "organization-runtime" ||
            selection.target.identity !== runtimeIdentityDigest(home.identity) ||
            selection.signingHash !== (await keys(home)) ||
            !isDeepStrictEqual(selection.namespace, { owner: "organization-runtime", identity: await namespace() })
          )
            throw new Error("The original native upgrade target changed")
        },
      })
      register?.()
      registerOrganizationHomeMigration(home.identity)
      RuntimeContext.sealComposition()
    })
    return { run: context.run, id: context.id, close }
  } catch (error) {
    await close()
    throw error
  }
}

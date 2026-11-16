import { expect, test } from "bun:test"
import { isDeepStrictEqual as same } from "node:util"
import { HomeOwnershipFile } from "../../src/lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "../../src/lifecycle/namespace-identity"
import { RuntimeMaintenanceSchema as Schema } from "../../src/storage/runtime-maintenance-schema"

const nativeIncarnation = "11111111-1111-4111-8111-111111111111"
const serviceIncarnation = "22222222-2222-4222-8222-222222222222"
const installationID = "33333333-3333-4333-8333-333333333333"
const hash = "a".repeat(64)

function selected(owner: string, identity: NativeNamespaceIdentity.Descriptor["identity"]) {
  const source = HomeOwnershipFile.RestorationInfo.parse({
    schemaVersion: 3,
    owner,
    identity: hash,
    readerContract: "native-organization-ownership-v5",
    installationID,
    incarnation: owner === "organization" ? serviceIncarnation : nativeIncarnation,
  })
  return {
    version: 2,
    source,
    target: { ...source, readerContract: "native-organization-ownership-v6" },
    namespace: { owner, identity },
    signingHash: hash,
  }
}

const hostedIdentity = {
  kind: "hosted",
  orgID: "organization",
  deploymentIncarnation: serviceIncarnation,
  runtimeID: "hosted-runtime",
  publicKey: "original-machine-public-key",
}

function variants(value: {
  version: number
  source: unknown
  target: unknown
  namespace: unknown
  signingHash: string
}) {
  const preparation = {
    version: value.version,
    source: value.source,
    namespace: value.namespace,
    signingHash: value.signingHash,
    selectionHash: hash,
  }
  const native = {
    ownerID: "original-native-owner",
    ownerVersion: 1,
    physicalHash: hash,
    primaryConfigHash: hash,
    artifactDirectory: "/original-artifacts",
  }
  return [
    { schema: Schema.HomeUpgradeSelection, input: value },
    { schema: Schema.HomeUpgradeNative, input: { ...value, ...native } },
    { schema: Schema.SourcePreparationSelection, input: preparation },
    { schema: Schema.SourcePreparationNative, input: { ...preparation, ...native } },
  ]
}

function accepted(value: Parameters<typeof variants>[0], preparation = true) {
  for (const control of preparation ? variants(value) : variants(value).slice(0, 2))
    expect(same(control.schema.parse(control.input), control.input)).toBe(true)
}

function refused(value: Parameters<typeof variants>[0], preparation = true) {
  for (const control of preparation ? variants(value) : variants(value).slice(0, 2))
    expect(control.schema.safeParse(control.input).success).toBe(false)
}

test("restored Hosted Home upgrade retains separate native installation and enrolled Service incarnations", () => {
  const value = selected("organization-runtime", hostedIdentity)
  expect(value.source.incarnation).not.toBe(value.namespace.identity.deploymentIncarnation)
  accepted(value, false)
  for (const control of variants(value).slice(2)) expect(control.schema.safeParse(control.input).success).toBe(false)
  expect(value.target).toEqual({ ...value.source, readerContract: "native-organization-ownership-v6" })
})

test("restored maintenance requires its exact typed namespace and refuses unknown restoration owners", () => {
  const value = selected("organization-runtime", hostedIdentity)
  refused({ ...value, namespace: { ...value.namespace, owner: "organization" } }, false)
  refused(selected("organization-runtime", { ...hostedIdentity, kind: "member" }), false)
  const { runtimeID: _runtimeID, ...incomplete } = hostedIdentity
  refused(selected("organization-runtime", incomplete), false)
  refused(selected("organization-runtime", { ...hostedIdentity, foreign: "unowned" }), false)
  refused(selected("unknown-restoration-owner", { ...hostedIdentity, deploymentIncarnation: nativeIncarnation }), false)
  refused({ ...value, version: 1 }, false)
})

test("restored Service maintenance still requires the original Service deployment incarnation", () => {
  const identity = { kind: "service", orgID: "organization", deploymentIncarnation: serviceIncarnation }
  accepted(selected("organization", identity))
  refused(selected("organization", { ...identity, deploymentIncarnation: nativeIncarnation }))
  refused(selected("organization", hostedIdentity), false)
})

test("a native Home upgrade cannot change either original local restoration identifier", () => {
  const value = selected("organization-runtime", hostedIdentity)
  for (const target of [
    { ...value.target, installationID: "44444444-4444-4444-8444-444444444444" },
    { ...value.target, incarnation: serviceIncarnation },
  ]) {
    expect(Schema.HomeUpgradeSelection.safeParse({ ...value, target }).success).toBe(false)
    expect(
      Schema.HomeUpgradeNative.safeParse({
        ...value,
        target,
        ownerID: "original-native-owner",
        ownerVersion: 1,
        physicalHash: hash,
        primaryConfigHash: hash,
        artifactDirectory: "/original-artifacts",
      }).success,
    ).toBe(false)
  }
})

test("ordinary version-one native maintenance retains its original fenced-owner contract", () => {
  const source = HomeOwnershipFile.FencedInfo.parse({
    schemaVersion: 2,
    owner: "ordinary-maintenance-fixture",
    identity: hash,
    readerContract: "ordinary-reader-v1",
  })
  accepted({
    version: 1,
    source,
    target: { ...source, readerContract: "ordinary-reader-v2" },
    namespace: { owner: source.owner, identity: { orgID: "organization", deploymentIncarnation: "original" } },
    signingHash: hash,
  })
})

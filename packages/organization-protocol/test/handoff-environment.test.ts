import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "../src/handoff"

const descriptor = {
  version: 1 as const,
  kind: "native" as const,
  platform: "linux",
  architecture: "x64",
  capabilities: ["exec", "files"] as const,
}
const native = {
  kind: "native",
  environmentID: "native-source",
  provider: "native",
  generation: 0,
  descriptor,
}
const cloud = { kind: "organization", resourceID: "compute", resourceRevision: 3, environmentID: "cloud-environment" }

test("explicit Environment mapping binds the complete native and logical resource choices", async () => {
  const mapping = Handoff.EnvironmentMapping.parse({
    version: 1,
    expectedSelectionRevision: 4,
    source: native,
    target: cloud,
  })
  const hash = await Handoff.planHash({ kind: "native" }, mapping)
  expect(hash).not.toBe(await Handoff.mappingHash({ kind: "native" }))
  expect(hash).not.toBe(await Handoff.planHash({ kind: "native" }, { ...mapping, expectedSelectionRevision: 5 }))
  if (mapping.target.kind !== "organization") throw new Error("Expected the actual selected logical Environment")
  expect(hash).not.toBe(
    await Handoff.planHash({ kind: "native" }, { ...mapping, target: { ...mapping.target, resourceRevision: 4 } }),
  )
  expect(hash).not.toBe(
    await Handoff.planHash({ kind: "native" }, { ...mapping, target: { ...mapping.target, environmentID: "another" } }),
  )
  expect(
    Handoff.EnvironmentMapping.safeParse({ ...mapping, target: { ...cloud, allocationID: "private" } }).success,
  ).toBe(false)
})

test("a fresh native target consents to a registered template without inventing an Environment identity", () => {
  const target = Handoff.NativeEnvironmentTarget.parse({
    kind: "native",
    provider: "native",
    descriptor,
    reference: null,
  })
  expect(target.reference).toBeNull()
  expect(Handoff.NativeEnvironmentSelection.safeParse(target).success).toBe(false)
  expect(
    Handoff.NativeEnvironmentTarget.safeParse({ ...target, reference: { environmentID: "existing", generation: 0 } })
      .success,
  ).toBe(true)
  expect(Handoff.NativeEnvironmentTarget.safeParse({ ...target, reference: undefined }).success).toBe(false)
  expect(Handoff.NativeEnvironmentTarget.safeParse({ ...target, directory: "/private" }).success).toBe(false)
  expect(
    Handoff.EnvironmentMapping.safeParse({
      version: 1,
      expectedSelectionRevision: 0,
      source: { kind: "none" },
      target: { kind: "none" },
    }).success,
  ).toBe(true)
  expect(
    Handoff.EnvironmentMapping.safeParse({ version: 1, expectedSelectionRevision: 0, source: null, target: null })
      .success,
  ).toBe(false)
})

import { expect, test } from "bun:test"
import { OrganizationCloudCleanupProtocol as Cleanup } from "../src/cloud-cleanup"

test("native cleanup selectors expose only original fact identities and separate inspection from retirement", () => {
  const admission = {
    kind: "admission",
    scopeID: "original-scope",
    environmentID: "original-environment",
    useID: JSON.stringify(["execution", "original-scope", "original-physical-operation"]),
    useHash: "a".repeat(64),
  } satisfies Cleanup.Candidate
  const preparation = { ...admission, kind: "preparation" } satisfies Cleanup.Candidate
  const execution = {
    kind: "execution",
    scopeID: admission.scopeID,
    environmentID: admission.environmentID,
    id: "original-physical-operation",
    digest: "b".repeat(64),
  } satisfies Cleanup.Candidate
  for (const selector of [admission, preparation, execution]) {
    expect(Cleanup.Candidate.parse(selector)).toEqual(selector)
    for (const extra of [{ directory: "/another" }, { origin: { owner: "claimed" } }, { view: {} }, { source: {} }])
      expect(Cleanup.Candidate.safeParse({ ...selector, ...extra }).success).toBe(false)
  }
  expect(Cleanup.Candidate.safeParse({ ...admission, useHash: "unknown" }).success).toBe(false)
  expect(Cleanup.Candidate.safeParse({ ...admission, useID: "" }).success).toBe(false)
  expect(Cleanup.Candidate.safeParse({ ...admission, useID: "x".repeat(4097) }).success).toBe(false)
  expect(Cleanup.ReconciliationProof.shape.action.safeParse("inspect").success).toBe(true)
  expect(Cleanup.ReconciliationProof.shape.action.safeParse("retire").success).toBe(true)
  for (const action of ["start", "prepare", "stdin", "resize", "allocate"])
    expect(Cleanup.ReconciliationProof.shape.action.safeParse(action).success).toBe(false)
  expect(Cleanup.DiscoveryProof.shape.page.parse({})).toEqual({ limit: 16 })
  expect(Cleanup.DiscoveryProof.shape.page.safeParse({ limit: 33 }).success).toBe(false)
  expect(Cleanup.Result.parse({ candidate: admission, state: "absent" }).state).toBe("absent")
  expect(Cleanup.Result.safeParse({ candidate: admission, state: "released", output: [] }).success).toBe(false)
})

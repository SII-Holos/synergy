import { expect, test } from "bun:test"
import { OrganizationApiTokenProtocol as Token } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationApiTokenIssuance } from "../../src/organization/api-token-state"

const request: Token.Create = {
  requestID: "request-one",
  projectID: "project-one",
  label: "Integration",
  operations: ["sessions.read", "artifacts.read"],
  expiresAt: 3000000000000,
}
const metadata: Token.Metadata = {
  tokenID: "token-one",
  orgID: "org-one",
  accountID: "account-one",
  projectID: request.projectID,
  label: request.label,
  operations: request.operations,
  revision: 1,
  createdAt: 1,
  expiresAt: request.expiresAt,
}
const secret = `sy_api_${"a".repeat(64)}`
function storage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}
test("unknown token issuance restores its exact original settings and cannot be replaced by a different request", () => {
  const values = storage()
  const first = createOrganizationApiTokenIssuance(values, "connection-one", "org-one", "account-one")
  first.begin(request)
  const restored = createOrganizationApiTokenIssuance(values, "connection-one", "org-one", "account-one")
  expect(restored.pending()?.request).toEqual(request)
  expect(() => restored.begin({ ...request, requestID: "another-request" })).toThrow()
  expect(
    createOrganizationApiTokenIssuance(values, "other-connection", "org-one", "account-one").pending(),
  ).toBeUndefined()
})
test("a one-time secret is returned to the current view and never enters issuance storage", () => {
  const values = storage()
  const state = createOrganizationApiTokenIssuance(values, "connection-one", "org-one", "account-one")
  state.begin(request)
  expect(state.accept({ metadata, token: secret, secretUnavailable: false }).token).toBe(secret)
  expect([...values.data.values()].join(" ")).not.toContain(secret)
  expect(state.pending()).toBeUndefined()
})
test("a lost secret blocks replacement until the exact issued token has a confirmed revocation", () => {
  const values = storage()
  const state = createOrganizationApiTokenIssuance(values, "connection-one", "org-one", "account-one")
  state.begin(request)
  state.accept({ metadata, secretUnavailable: true })
  expect(state.pending()?.issued).toEqual(metadata)
  expect(() => state.begin({ ...request, requestID: "new-request" })).toThrow()
  expect(() => state.revoked({ ...metadata, tokenID: "another-token", revokedAt: 2, revision: 2 })).toThrow()
  expect(state.pending()).toBeDefined()
  state.revoked({ ...metadata, revokedAt: 2, revision: 2 })
  expect(state.pending()).toBeUndefined()
  expect(() => state.begin({ ...request, requestID: "new-request" })).not.toThrow()
})
test("another owner or altered token capabilities cannot confirm issuance", () => {
  const values = storage()
  const state = createOrganizationApiTokenIssuance(values, "connection-one", "org-one", "account-one")
  state.begin(request)
  for (const changed of [
    { accountID: "another-account" },
    { projectID: "another-project" },
    { operations: ["sessions.input"] },
    { expiresAt: request.expiresAt + 1 },
  ]) {
    expect(() => state.accept({ metadata: { ...metadata, ...changed }, secretUnavailable: true })).toThrow()
    expect(state.pending()?.request).toEqual(request)
  }
})

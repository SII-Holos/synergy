import { expect, test } from "bun:test"
import { DesktopOrganizationClientError } from "../../src/organization/desktop"
import { OrganizationSessionReadError } from "../../src/organization/private-read"
import { organizationOwnerFailure } from "../../src/organization/owner-error"

test("canonical API and Main error codes invalidate the same captured reader owner", () => {
  for (const value of [
    { code: "PERMISSION_DENIED" },
    { code: "NOT_FOUND" },
    { code: "SHARE_REVOKED" },
    new DesktopOrganizationClientError("permission_denied"),
  ])
    expect(organizationOwnerFailure(value)).toBe("access")
  for (const value of [
    { code: "AUTHENTICATION_REQUIRED" },
    new DesktopOrganizationClientError("reauthorization_required"),
    new DesktopOrganizationClientError("signed_out"),
    new DesktopOrganizationClientError("identity_changed"),
  ])
    expect(organizationOwnerFailure(value)).toBe("authentication")
  for (const value of [new OrganizationSessionReadError("STALE_BINDING"), { code: "STALE_CONNECTION" }])
    expect(organizationOwnerFailure(value)).toBe("binding")
})
test("offline, uncertain admission and snapshot conflicts preserve the owner for recovery", () => {
  for (const code of [
    "RUNTIME_OFFLINE",
    "COMMAND_OUTCOME_UNKNOWN",
    "REVISION_CONFLICT",
    "cancelled",
    "INVALID_REQUEST",
  ])
    expect(organizationOwnerFailure({ code })).toBeUndefined()
})
test("diagnostic text, status numbers and unrelated nested data cannot become an authority signal", () => {
  for (const value of [
    new Error("PERMISSION_DENIED"),
    { status: 403 },
    { data: { code: "PERMISSION_DENIED" } },
    "AUTHENTICATION_REQUIRED",
    null,
    undefined,
  ])
    expect(organizationOwnerFailure(value)).toBeUndefined()
})

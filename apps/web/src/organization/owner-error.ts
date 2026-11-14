export type OrganizationOwnerFailure = "authentication" | "access" | "binding"
export function organizationOwnerFailure(error: unknown): OrganizationOwnerFailure | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
    case "reauthorization_required":
    case "signed_out":
    case "identity_changed":
      return "authentication"
    case "PERMISSION_DENIED":
    case "NOT_FOUND":
    case "SHARE_REVOKED":
    case "permission_denied":
      return "access"
    case "STALE_BINDING":
    case "STALE_CONNECTION":
      return "binding"
  }
}

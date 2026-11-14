export const organizationAuthMessages = {
  title: { id: "organization.auth.title", message: "Connect to your organization" },
  signIn: { id: "organization.auth.signIn", message: "Sign in" },
  loginName: { id: "organization.auth.loginName", message: "Account" },
  password: { id: "organization.auth.password", message: "Password" },
  continue: { id: "organization.auth.continue", message: "Continue" },
  destination: { id: "organization.auth.destination", message: "Connect this account to {client}." },
  desktop: { id: "organization.auth.desktop", message: "Synergy Desktop" },
  signOut: { id: "organization.auth.signOut", message: "Sign out" },
  loading: { id: "organization.auth.loading", message: "Checking your organization connection…" },
  working: { id: "organization.auth.working", message: "Connecting…" },
  invalid: {
    id: "organization.auth.invalid",
    message: "This connection link is no longer valid. Return to Synergy and restore the organization connection.",
  },
  signInFailed: {
    id: "organization.auth.signInFailed",
    message: "Sign-in failed. Check your account and password, then try again.",
  },
  expired: { id: "organization.auth.expired", message: "Your sign-in has expired. Sign in again to continue." },
  unavailable: { id: "organization.auth.unavailable", message: "Could not connect to the organization. Try again." },
  retry: { id: "organization.auth.retry", message: "Try again" },
  returning: { id: "organization.auth.returning", message: "Returning to Synergy…" },
  missingWindow: {
    id: "organization.auth.missingWindow",
    message: "The original window is unavailable. Return to Synergy and restore the organization connection.",
  },
  close: { id: "organization.auth.close", message: "Close window" },
} as const

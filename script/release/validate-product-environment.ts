#!/usr/bin/env bun

const REQUIRED_RELEASE_ENV = [
  "NPM_TOKEN",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
] as const

const WINDOWS_SIGNING_ENV = ["WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD"] as const

export function validateProductReleaseEnvironment(env: Record<string, string | undefined>): void {
  const missing: string[] = REQUIRED_RELEASE_ENV.filter((name) => !env[name]?.trim())
  if (missing.length > 0) throw new Error(`Product release environment is missing: ${missing.join(", ")}`)

  const windowsConfigured = WINDOWS_SIGNING_ENV.filter((name) => env[name]?.trim())
  if (windowsConfigured.length > 0 && windowsConfigured.length < WINDOWS_SIGNING_ENV.length) {
    const partiallyMissing = WINDOWS_SIGNING_ENV.filter((name) => !env[name]?.trim())
    throw new Error(`Windows signing environment is partially configured: ${partiallyMissing.join(", ")}`)
  }

  const windowsCertificateValue = env.WINDOWS_CERTIFICATE?.trim()
  if (windowsCertificateValue) {
    const windowsCertificate = Buffer.from(windowsCertificateValue, "base64")
    if (windowsCertificate.byteLength < 2 || windowsCertificate[0] !== 0x30) {
      throw new Error("WINDOWS_CERTIFICATE must be a base64-encoded PKCS#12 certificate")
    }
  }
}

if (import.meta.main) {
  validateProductReleaseEnvironment(process.env)
  console.log("Product release signing environment is valid")
}

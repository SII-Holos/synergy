#!/usr/bin/env bun

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto"

const REQUIRED_RELEASE_ENV = [
  "NPM_TOKEN",
  "BROWSER_HOST_MANIFEST_SIGNING_KEY",
  "BROWSER_HOST_MANIFEST_PUBLIC_KEY",
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

  if (env.WINDOWS_CERTIFICATE?.trim()) {
    const windowsCertificate = Buffer.from(env.WINDOWS_CERTIFICATE, "base64")
    if (windowsCertificate.byteLength < 2 || windowsCertificate[0] !== 0x30) {
      throw new Error("WINDOWS_CERTIFICATE must be a base64-encoded PKCS#12 certificate")
    }
  }

  const privateKey = createPrivateKey({
    key: Buffer.from(env.BROWSER_HOST_MANIFEST_SIGNING_KEY!, "base64"),
    format: "der",
    type: "pkcs8",
  })
  const publicKeyBytes = Buffer.from(env.BROWSER_HOST_MANIFEST_PUBLIC_KEY!, "base64")
  if (publicKeyBytes.byteLength !== 32) {
    throw new Error("BROWSER_HOST_MANIFEST_PUBLIC_KEY must be a 32-byte raw Ed25519 public key")
  }
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex")
  const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, publicKeyBytes]), format: "der", type: "spki" })
  const challenge = Buffer.from("synergy-browser-host-release-key-pair")
  const signature = sign(null, challenge, privateKey)
  if (!verify(null, challenge, publicKey, signature)) {
    throw new Error("Browser Host manifest signing and public keys do not match")
  }
}

if (import.meta.main) {
  validateProductReleaseEnvironment(process.env)
  console.log("Product release signing environment is valid")
}

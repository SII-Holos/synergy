import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { validateProductReleaseEnvironment } from "../../../script/release/validate-product-environment"

function environment() {
  const pair = generateKeyPairSync("ed25519")
  const publicJwk = pair.publicKey.export({ format: "jwk" })
  if (!publicJwk.x) throw new Error("Missing fixture Ed25519 public key")
  return {
    NPM_TOKEN: "npm-token",
    BROWSER_HOST_MANIFEST_SIGNING_KEY: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    BROWSER_HOST_MANIFEST_PUBLIC_KEY: Buffer.from(publicJwk.x, "base64url").toString("base64"),
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-password",
    APPLE_TEAM_ID: "team-id",
    CSC_LINK: "mac-certificate",
    CSC_KEY_PASSWORD: "mac-certificate-password",
    CSC_INSTALLER_LINK: "mac-installer-certificate",
    CSC_INSTALLER_KEY_PASSWORD: "mac-installer-certificate-password",
    WINDOWS_CERTIFICATE: "windows-certificate",
    WINDOWS_CERTIFICATE_PASSWORD: "windows-certificate-password",
  }
}

describe("product release environment", () => {
  test("accepts complete signing material with a matching Browser Host key pair", () => {
    expect(() => validateProductReleaseEnvironment(environment())).not.toThrow()
  })

  test("rejects missing signing material before publishing a candidate", () => {
    const env = environment()
    delete (env as Partial<typeof env>).APPLE_TEAM_ID
    expect(() => validateProductReleaseEnvironment(env)).toThrow(/APPLE_TEAM_ID/)
  })

  test("accepts unsigned Windows artifacts when both signing values are absent", () => {
    const env = environment()
    delete (env as Partial<typeof env>).WINDOWS_CERTIFICATE
    delete (env as Partial<typeof env>).WINDOWS_CERTIFICATE_PASSWORD
    expect(() => validateProductReleaseEnvironment(env)).not.toThrow()
  })

  test("rejects a partially configured Windows signing identity", () => {
    const env = environment()
    delete (env as Partial<typeof env>).WINDOWS_CERTIFICATE_PASSWORD
    expect(() => validateProductReleaseEnvironment(env)).toThrow(/WINDOWS_CERTIFICATE_PASSWORD/)
  })

  test("rejects a missing macOS Installer signing identity", () => {
    const env = environment()
    delete (env as Partial<typeof env>).CSC_INSTALLER_LINK
    expect(() => validateProductReleaseEnvironment(env)).toThrow(/CSC_INSTALLER_LINK/)
  })

  test("rejects a mismatched Browser Host key pair", () => {
    const env = environment()
    env.BROWSER_HOST_MANIFEST_PUBLIC_KEY = environment().BROWSER_HOST_MANIFEST_PUBLIC_KEY
    expect(() => validateProductReleaseEnvironment(env)).toThrow(/do not match/)
  })
})

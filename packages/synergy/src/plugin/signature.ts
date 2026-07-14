import { sha256File } from "../util/crypto"
import { subtle } from "node:crypto"
import { Log } from "../util/log"
import fs from "fs"
import path from "path"
import { PluginPaths } from "./paths"

const log = Log.create({ service: "plugin.signature" })

// ---------------------------------------------------------------------------
// Signature metadata shape (matches output of plugin-sign command)
// ---------------------------------------------------------------------------

export interface SignatureMetadata {
  signatureVersion: number
  pluginId: string
  version: string
  algorithm: string
  signer: string // public key hex
  signature: string // signature hex
  signedAt: number
  payload: {
    tarballHash: string
    manifestHash: string
    permissionsHash: string
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Look up the public key from the signing key store.
 * Returns the raw public key as a hex string, or null if no key is found.
 */
function readPublicKey(signerHex: string): string | null {
  // Check if this matches the local signing key
  const KEY_FILE = PluginPaths.signingKeyFile()
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf-8")
    const key = JSON.parse(raw) as { publicKey: string; privateKey: string }
    if (key.publicKey === signerHex) return key.publicKey
  } catch {
    // no key file
  }

  // Check well-known keys directory
  const wellKnownDir = PluginPaths.trustedSigningKeysDir()
  try {
    const entries = fs.readdirSync(wellKnownDir)
    for (const entry of entries) {
      if (entry.endsWith(".pub")) {
        try {
          const pubHex = fs.readFileSync(path.join(wellKnownDir, entry), "utf-8").trim()
          if (pubHex === signerHex) return pubHex
        } catch {
          // skip unreadable key
        }
      }
    }
  } catch {
    // no trusted keys directory
  }

  return null
}

/**
 * Verify a plugin signature against a tarball.
 *
 * @param tarballPath - path to the .synergy-plugin.tgz tarball
 * @param sigMeta - the signature metadata to verify
 * @returns true if the signature is valid
 */
export async function verifySignature(tarballPath: string, sigMeta: SignatureMetadata): Promise<boolean> {
  try {
    // 1. Verify algorithm is supported
    if (sigMeta.algorithm !== "ed25519") {
      log.warn("unsupported signature algorithm", { algorithm: sigMeta.algorithm })
      return false
    }

    // 2. Look up the signer's public key
    const publicKeyHex = readPublicKey(sigMeta.signer)
    if (!publicKeyHex) {
      log.warn("signer public key not found", { signer: sigMeta.signer.slice(0, 16) + "..." })
      // If the signer is unknown, we cannot verify but may still choose to trust
      return false
    }

    return verifySignatureWithPublicKey(tarballPath, sigMeta, publicKeyHex)
  } catch (err) {
    log.error("signature verification error", { err })
    return false
  }
}

/**
 * Verify a tarball signature against an explicit registry-reviewed public key.
 *
 * This is used by the official GitHub-backed plugin registry, where the registry
 * entry itself is the trust root for the version signer.
 */
export async function verifySignatureWithPublicKey(
  tarballPath: string,
  sigMeta: SignatureMetadata,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    if (sigMeta.algorithm !== "ed25519") {
      log.warn("unsupported signature algorithm", { algorithm: sigMeta.algorithm })
      return false
    }

    if (sigMeta.signer !== publicKeyHex) {
      log.warn("signature signer does not match trusted public key", {
        signer: sigMeta.signer.slice(0, 16) + "...",
        trusted: publicKeyHex.slice(0, 16) + "...",
      })
      return false
    }

    const actualTarballHash = sha256File(tarballPath)
    if (actualTarballHash !== sigMeta.payload.tarballHash) {
      log.warn("tarball hash mismatch", {
        expected: sigMeta.payload.tarballHash.slice(0, 16) + "...",
        actual: actualTarballHash.slice(0, 16) + "...",
      })
      return false
    }

    const payloadJSON = JSON.stringify(sigMeta.payload)
    const raw = Buffer.from(publicKeyHex, "hex")
    const publicKey = await subtle.importKey("raw", raw, "Ed25519" as any, false, ["verify"])
    const signature = Buffer.from(sigMeta.signature, "hex")

    return await subtle.verify("Ed25519" as any, publicKey, signature, new TextEncoder().encode(payloadJSON))
  } catch (err) {
    log.error("signature verification error", { err })
    return false
  }
}

/**
 * Verify the cryptographic signature validity and payload hash consistency
 * against an installed plugin's files (no tarball required).
 *
 * Used during install when the tarball has already been extracted.
 *
 * @param sigMeta - the signature metadata to verify
 * @param manifestHash - the manifest hash from the installed plugin
 * @param permissionsHash - the permissions hash from the installed plugin
 * @returns true if the signature is cryptographically valid AND payload hashes match
 */
export async function verifySignatureFromHashes(
  sigMeta: SignatureMetadata,
  manifestHash: string,
  permissionsHash: string,
): Promise<boolean> {
  try {
    // 1. Verify algorithm is supported
    if (sigMeta.algorithm !== "ed25519") {
      log.warn("unsupported signature algorithm", { algorithm: sigMeta.algorithm })
      return false
    }

    // 2. Verify manifest hash matches
    if (sigMeta.payload.manifestHash !== manifestHash) {
      log.warn("signature manifest hash mismatch", {
        expected: sigMeta.payload.manifestHash.slice(0, 16) + "...",
        actual: manifestHash.slice(0, 16) + "...",
      })
      return false
    }

    // 3. Verify permissions hash matches
    if (sigMeta.payload.permissionsHash !== permissionsHash) {
      log.warn("signature permissions hash mismatch", {
        expected: sigMeta.payload.permissionsHash.slice(0, 16) + "...",
        actual: permissionsHash.slice(0, 16) + "...",
      })
      return false
    }

    // 4. Look up the signer's public key
    const publicKeyHex = readPublicKey(sigMeta.signer)
    if (!publicKeyHex) {
      log.warn("signer public key not found", { signer: sigMeta.signer.slice(0, 16) + "..." })
      return false
    }

    // 5. Reconstruct the signed payload and verify
    const payloadJSON = JSON.stringify(sigMeta.payload)
    const raw = Buffer.from(publicKeyHex, "hex")
    const publicKey = await subtle.importKey("raw", raw, "Ed25519" as any, false, ["verify"])
    const signature = Buffer.from(sigMeta.signature, "hex")

    return await subtle.verify("Ed25519" as any, publicKey, signature, new TextEncoder().encode(payloadJSON))
  } catch (err) {
    log.error("signature verification error", { err })
    return false
  }
}

/**
 * Attempt to find and read a signature file alongside a tarball.
 *
 * Looks for `<tarball>.sig` next to the tarball.
 * Returns the parsed metadata if found, or null.
 */
export function readSignatureFile(tarballPath: string): SignatureMetadata | null {
  const sigPath = tarballPath + ".sig"
  try {
    const raw = fs.readFileSync(sigPath, "utf-8")
    const parsed = JSON.parse(raw) as SignatureMetadata
    // Basic validation
    if (
      typeof parsed.signatureVersion === "number" &&
      typeof parsed.pluginId === "string" &&
      typeof parsed.algorithm === "string" &&
      typeof parsed.signer === "string" &&
      typeof parsed.signature === "string" &&
      parsed.payload &&
      typeof parsed.payload.tarballHash === "string"
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

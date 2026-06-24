import path from "path"
import fs from "fs"
import { EOL } from "os"
import { subtle } from "node:crypto"
import type { Argv } from "yargs"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd"
import { UI } from "../ui"
import { SIGNING_KEYS_DIR, SIGNING_KEY_FILE } from "../lib/paths"
import { sha256File } from "../lib/crypto"
import type { SignatureMetadata } from "../lib/signature"
import { baseCapabilities } from "../lib/capability"
import { computeManifestHash, computePermissionsHash } from "../lib/hash"

interface KeyFile {
  publicKey: string
  privateKey: string
}

function extractFromTarball(tarballPath: string, memberPath: string): string | null {
  const result = Bun.spawnSync(["tar", "-xOf", tarballPath, memberPath], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) return null
  return new TextDecoder().decode(result.stdout)
}

function readKeyFile(): KeyFile | null {
  try {
    return JSON.parse(fs.readFileSync(SIGNING_KEY_FILE, "utf-8")) as KeyFile
  } catch {
    return null
  }
}

function writeKeyFile(key: KeyFile): void {
  fs.mkdirSync(SIGNING_KEYS_DIR, { recursive: true })
  fs.writeFileSync(SIGNING_KEY_FILE, JSON.stringify(key, null, 2), { mode: 0o600 })
}

async function generateKeyPair(): Promise<KeyFile> {
  const key = (await subtle.generateKey("Ed25519" as any, true, ["sign", "verify"])) as CryptoKeyPair
  const privRaw = await subtle.exportKey("pkcs8", key.privateKey)
  const pubRaw = await subtle.exportKey("raw", key.publicKey)
  return {
    privateKey: Buffer.from(privRaw as ArrayBuffer).toString("hex"),
    publicKey: Buffer.from(pubRaw as ArrayBuffer).toString("hex"),
  }
}

async function importPrivateKey(hex: string): Promise<CryptoKey> {
  return subtle.importKey("pkcs8", Buffer.from(hex, "hex"), "Ed25519" as any, false, ["sign"])
}

export async function signPluginTarball(tarballPath: string, options: { stdout?: boolean } = {}): Promise<string> {
  if (!fs.existsSync(tarballPath)) throw new Error(`Tarball not found: ${tarballPath}`)

  UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Signing${UI.Style.TEXT_NORMAL} ${path.basename(tarballPath)}`)

  const tarballHash = sha256File(tarballPath)
  const manifestRaw = extractFromTarball(tarballPath, "plugin.normalized.json")
  if (!manifestRaw) throw new Error("Failed to extract plugin.normalized.json from tarball. Has the plugin been built?")

  let manifest: PluginManifestType
  try {
    manifest = PluginManifest.parse(JSON.parse(manifestRaw)) as PluginManifestType
  } catch {
    throw new Error("Failed to parse plugin.normalized.json from tarball")
  }

  if (!extractFromTarball(tarballPath, "permissions.summary.json")) {
    throw new Error("Failed to extract permissions.summary.json from tarball. Has the plugin been built?")
  }

  let keyFile = readKeyFile()
  let isNewKey = false
  if (!keyFile) {
    UI.println(`  ${UI.Style.TEXT_DIM}No signing key found. Generating new ed25519 keypair...${UI.Style.TEXT_NORMAL}`)
    keyFile = await generateKeyPair()
    writeKeyFile(keyFile)
    isNewKey = true
  }

  const payload = {
    tarballHash,
    manifestHash: computeManifestHash(manifest),
    permissionsHash: computePermissionsHash(manifest, baseCapabilities(manifest)),
  }
  const privateKey = await importPrivateKey(keyFile.privateKey)
  const sigRaw = await subtle.sign("Ed25519" as any, privateKey, new TextEncoder().encode(JSON.stringify(payload)))
  const signature: SignatureMetadata = {
    signatureVersion: 1,
    pluginId: manifest.name,
    version: manifest.version,
    algorithm: "ed25519",
    signer: keyFile.publicKey,
    signature: Buffer.from(sigRaw as ArrayBuffer).toString("hex"),
    signedAt: Date.now(),
    payload,
  }

  const sigPath = `${tarballPath}.sig`
  const rendered = JSON.stringify(signature, null, 2) + EOL
  fs.writeFileSync(sigPath, rendered)
  if (options.stdout) process.stdout.write(rendered)

  UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Signed ${manifest.name} v${manifest.version}`)
  if (isNewKey) UI.println(`  ${UI.Style.TEXT_DIM}New signing key generated${UI.Style.TEXT_NORMAL}`)
  UI.println(`  ${UI.Style.TEXT_DIM}Signature:${UI.Style.TEXT_NORMAL} ${sigPath}`)
  UI.println(`  ${UI.Style.TEXT_DIM}Signer:${UI.Style.TEXT_NORMAL} ${keyFile.publicKey.slice(0, 16)}...`)
  UI.println(`  ${UI.Style.TEXT_DIM}Key stored at:${UI.Style.TEXT_NORMAL} ${SIGNING_KEY_FILE}`)
  return sigPath
}

export const PluginSignCommand = cmd({
  command: "sign <tarball>",
  describe: "sign a plugin package tarball",
  builder: (yargs: Argv) =>
    yargs
      .positional("tarball", {
        type: "string",
        describe: "path to .synergy-plugin.tgz tarball",
        demandOption: true,
      })
      .option("stdout", {
        type: "boolean",
        default: false,
        describe: "also print the signature JSON to stdout",
      }),
  async handler(args) {
    try {
      await signPluginTarball(path.resolve(args.tarball as string), { stdout: Boolean(args.stdout) })
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
})

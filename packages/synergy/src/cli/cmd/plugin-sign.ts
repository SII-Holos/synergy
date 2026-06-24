import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { sha256File, sha256Content } from "../../util/crypto"
import { Global } from "@/global"
import { EOL } from "os"
import path from "path"
import fs from "fs"
import { subtle } from "node:crypto"
import type { Argv } from "yargs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFromTarball(tarballPath: string, memberPath: string): string | null {
  const result = Bun.spawnSync(["tar", "-xOf", tarballPath, memberPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) return null
  return new TextDecoder().decode(result.stdout)
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

interface KeyFile {
  publicKey: string
  privateKey: string
}

const KEYS_DIR = path.join(Global.Path.root, "keys")
const KEY_FILE = path.join(KEYS_DIR, "signing-key.json")

function readKeyFile(): KeyFile | null {
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf-8")
    return JSON.parse(raw) as KeyFile
  } catch {
    return null
  }
}

function writeKeyFile(key: KeyFile): void {
  fs.mkdirSync(KEYS_DIR, { recursive: true })
  fs.writeFileSync(KEY_FILE, JSON.stringify(key, null, 2), { mode: 0o600 })
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
  const raw = Buffer.from(hex, "hex")
  return subtle.importKey("pkcs8", raw, "Ed25519" as any, false, ["sign"])
}

// ---------------------------------------------------------------------------
// sign <tarball>
// ---------------------------------------------------------------------------

export const PluginSignCommand = cmd({
  command: "sign <tarball>",
  describe: "sign a plugin package tarball",
  builder: (yargs: Argv) =>
    yargs.positional("tarball", {
      type: "string",
      describe: "path to .synergy-plugin.tgz tarball",
      demandOption: true,
    }),
  async handler(args) {
    const tarballPath = path.resolve(args.tarball as string)

    if (!fs.existsSync(tarballPath)) {
      UI.error(`Tarball not found: ${tarballPath}`)
      process.exitCode = 1
      return
    }

    const spinner = (message: string) => {
      process.stderr.write(`${UI.Style.TEXT_DIM}  ${message}...${UI.Style.TEXT_NORMAL}${EOL}`)
    }

    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Signing${UI.Style.TEXT_NORMAL} ${path.basename(tarballPath)}`)

    // 1. Hash the tarball
    spinner("Hashing tarball")
    const tarballHash = sha256File(tarballPath)

    // 2. Extract manifest and permissions from tarball
    spinner("Extracting manifest")
    const manifestRaw = extractFromTarball(tarballPath, "plugin.normalized.json")
    if (!manifestRaw) {
      UI.error(`Failed to extract plugin.normalized.json from tarball. Has the plugin been built?`)
      process.exitCode = 1
      return
    }

    let manifest: PluginManifestType
    try {
      const parsed = PluginManifest.safeParse(JSON.parse(manifestRaw))
      if (!parsed.success) {
        UI.error("Invalid plugin manifest in tarball:")
        for (const issue of parsed.error.issues) {
          UI.println(`  ${UI.Style.TEXT_DIM}${issue.path.join(".")}:${UI.Style.TEXT_NORMAL} ${issue.message}`)
        }
        process.exitCode = 1
        return
      }
      manifest = parsed.data as PluginManifestType
    } catch {
      UI.error("Failed to parse plugin.normalized.json from tarball")
      process.exitCode = 1
      return
    }

    spinner("Extracting permissions summary")
    const permissionsRaw = extractFromTarball(tarballPath, "permissions.summary.json")
    if (!permissionsRaw) {
      UI.error(`Failed to extract permissions.summary.json from tarball. Has the plugin been built?`)
      process.exitCode = 1
      return
    }

    // 3. Hash manifest and permissions content
    spinner("Computing hashes")
    const manifestHash = sha256Content(manifestRaw)
    const permissionsHash = sha256Content(permissionsRaw)

    // 4. Create signing payload
    const payload: Record<string, unknown> = {
      tarballHash,
      manifestHash,
      permissionsHash,
    }
    const payloadJSON = JSON.stringify(payload)

    // 5. Get or create signing key
    spinner("Loading signing key")
    let keyFile = readKeyFile()
    let isNewKey = false

    if (!keyFile) {
      UI.println(`  ${UI.Style.TEXT_DIM}No signing key found. Generating new ed25519 keypair...${UI.Style.TEXT_NORMAL}`)
      keyFile = await generateKeyPair()
      writeKeyFile(keyFile)
      isNewKey = true
    }

    // 6. Sign
    spinner("Signing payload")
    const privateKey = await importPrivateKey(keyFile.privateKey)
    const sigRaw = await subtle.sign("Ed25519" as any, privateKey, new TextEncoder().encode(payloadJSON))
    const signature = Buffer.from(sigRaw as ArrayBuffer).toString("hex")

    // 7. Output signature metadata
    const sigMetadata: Record<string, unknown> = {
      signatureVersion: 1,
      pluginId: manifest.name,
      version: manifest.version,
      algorithm: "ed25519",
      signer: keyFile.publicKey,
      signature,
      signedAt: Date.now(),
      payload,
    }

    process.stdout.write(JSON.stringify(sigMetadata, null, 2) + EOL)

    UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Signed ${manifest.name} v${manifest.version}`)
    if (isNewKey) {
      UI.println(`  ${UI.Style.TEXT_DIM}New signing key generated${UI.Style.TEXT_NORMAL}`)
    }
    UI.println(`  ${UI.Style.TEXT_DIM}Signer:${UI.Style.TEXT_NORMAL} ${keyFile.publicKey.slice(0, 16)}...`)
    UI.println(`  ${UI.Style.TEXT_DIM}Key stored at:${UI.Style.TEXT_NORMAL} ${KEY_FILE}`)
  },
})

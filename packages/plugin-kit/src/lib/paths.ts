import os from "os"
import path from "path"

export const SYNERGY_ROOT = process.env.SYNERGY_HOME || path.join(os.homedir(), ".synergy")
export const SIGNING_KEYS_DIR = path.join(SYNERGY_ROOT, "keys")
export const SIGNING_KEY_FILE = path.join(SIGNING_KEYS_DIR, "signing-key.json")

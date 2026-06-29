import os from "os"
import path from "path"

export const SYNERGY_HOME = process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME || os.homedir()
export const SYNERGY_ROOT = path.join(SYNERGY_HOME, ".synergy")
export const SIGNING_KEYS_DIR = path.join(SYNERGY_ROOT, "keys")
export const SIGNING_KEY_FILE = path.join(SIGNING_KEYS_DIR, "signing-key.json")

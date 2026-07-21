import os from "os"
import path from "path"

export type SynergyPathEnv = Readonly<Record<string, string | undefined>>

export function synergyHome(env: SynergyPathEnv = process.env): string {
  return env.SYNERGY_HOME || env.SYNERGY_TEST_HOME || os.homedir()
}

export function synergyRoot(env: SynergyPathEnv = process.env): string {
  return path.join(synergyHome(env), ".synergy")
}

export function synergySigningKeysDir(env: SynergyPathEnv = process.env): string {
  return path.join(synergyRoot(env), "keys")
}

export function synergySigningKeyFile(env: SynergyPathEnv = process.env): string {
  return path.join(synergySigningKeysDir(env), "signing-key.json")
}

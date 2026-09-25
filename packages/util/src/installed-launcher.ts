import { z } from "zod"

export const InstallationPin = z.object({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

export function installedWorkerCommand(env: Record<string, string | undefined>, runner: string, args: string[] = []) {
  if (!env.SYNERGY_INSTALLATION_PIN) return undefined
  InstallationPin.parse(JSON.parse(env.SYNERGY_INSTALLATION_PIN))
  if (!env.SYNERGY_LAUNCHER_COMMAND) throw new Error("An installed worker requires its verified launcher")
  const command = z.array(z.string().min(1)).min(1).parse(JSON.parse(env.SYNERGY_LAUNCHER_COMMAND))
  return [...command, runner, ...args]
}

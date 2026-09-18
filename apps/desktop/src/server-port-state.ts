import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import type { DesktopChannel } from "./identity.js"

export const DesktopServerPortStateV1 = z
  .object({
    version: z.literal(1),
    channel: z.enum(["dev", "stable"]),
    port: z.number().int().min(1024).max(65535),
    updatedAt: z.string(),
  })
  .strict()
export type DesktopServerPortStateV1 = z.infer<typeof DesktopServerPortStateV1>

const DESKTOP_SERVER_PORT_FILE = "server-port.json"

export function desktopServerPortFilePath(userDataPath: string): string {
  return path.join(userDataPath, DESKTOP_SERVER_PORT_FILE)
}

export async function loadServerPort(userDataPath: string, channel: DesktopChannel): Promise<number | undefined> {
  try {
    const content = await readFile(desktopServerPortFilePath(userDataPath), "utf8")
    const parsed = DesktopServerPortStateV1.safeParse(JSON.parse(content))
    if (parsed.success && parsed.data.channel === channel) return parsed.data.port
  } catch {
    // Missing, unreadable, or foreign-channel state falls back to the default port chain.
  }
  return undefined
}

export async function saveServerPort(userDataPath: string, channel: DesktopChannel, port: number): Promise<void> {
  const filepath = desktopServerPortFilePath(userDataPath)
  const state: DesktopServerPortStateV1 = {
    version: 1,
    channel,
    port,
    updatedAt: new Date().toISOString(),
  }
  await mkdir(path.dirname(filepath), { recursive: true })
  await writeFile(filepath, `${JSON.stringify(state, null, 2)}\n`)
}

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

export async function readEvents(file: string) {
  let terminal: Record<string, unknown> | undefined
  let identity: { sessionID: string; runID: string } | undefined
  let invalid_lines = 0
  const stream = createReadStream(file)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event.type === "result" || event.type === "failed") terminal = event
        if (typeof event.sessionID === "string" && typeof event.runID === "string") identity = event
      } catch {
        invalid_lines++
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return { terminal, identity, invalid_lines }
}

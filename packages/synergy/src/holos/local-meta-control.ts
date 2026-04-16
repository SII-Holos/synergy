import net from "node:net"
import z from "zod"

const CONTROL_TIMEOUT_MS = 500

const ControlResponse = z.union([
  z.object({ ok: z.literal(true), payload: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
])

type ControlResponse = z.infer<typeof ControlResponse>

export namespace HolosLocalMetaControl {
  export async function isAvailable(controlSocketPath: string, timeoutMs = CONTROL_TIMEOUT_MS): Promise<boolean> {
    try {
      const response = await request(controlSocketPath, { action: "ping" }, { timeoutMs })
      return response.ok
    } catch {
      return false
    }
  }

  export async function request(
    controlSocketPath: string,
    payload: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<ControlResponse> {
    return await new Promise<ControlResponse>((resolve, reject) => {
      const socket = net.createConnection(controlSocketPath)
      const timeout = setTimeout(() => {
        socket.destroy(new Error(`Timed out connecting to control socket at ${controlSocketPath}`))
      }, options?.timeoutMs ?? CONTROL_TIMEOUT_MS)
      let settled = false
      let buffer = ""

      function finish(error?: Error, result?: ControlResponse) {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        socket.removeAllListeners()
        socket.end()
        if (error) {
          reject(error)
          return
        }
        resolve(result!)
      }

      socket.setEncoding("utf8")
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(payload)}\n`)
      })
      socket.on("data", (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        try {
          finish(undefined, ControlResponse.parse(JSON.parse(line)))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.once("error", (error) => finish(error))
      socket.once("end", () => {
        if (!settled) {
          finish(new Error("Control socket closed before replying"))
        }
      })
    })
  }
}

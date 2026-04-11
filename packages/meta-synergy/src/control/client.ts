import net from "node:net"
import { MetaSynergyStore } from "../state/store"
import {
  ControlRequestSchema,
  ControlResponseSchema,
  type MetaSynergyControlRequest,
  type MetaSynergyControlResponse,
} from "./schema"

export class MetaSynergyControlClient {
  static socketPath() {
    return MetaSynergyStore.controlSocketPath()
  }

  static async isAvailable() {
    try {
      await this.request({ action: "ping" }, { timeoutMs: 250 })
      return true
    } catch {
      return false
    }
  }

  static async request<T = unknown>(input: MetaSynergyControlRequest, options?: { timeoutMs?: number }): Promise<T> {
    const request = ControlRequestSchema.parse(input)
    const response = await requestViaSocket(request, options)
    const parsed = ControlResponseSchema.parse(response)
    if (!parsed.ok) {
      const error = new Error(parsed.error.message)
      ;(error as Error & { code?: string }).code = parsed.error.code
      throw error
    }
    return parsed.payload as T
  }
}

async function requestViaSocket(
  request: MetaSynergyControlRequest,
  options?: { timeoutMs?: number },
): Promise<MetaSynergyControlResponse> {
  const socketPath = MetaSynergyControlClient.socketPath()
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`Timed out connecting to control socket at ${socketPath}`))
    }, options?.timeoutMs ?? 2_000)
    let settled = false
    let buffer = ""

    function finish(error?: Error, result?: MetaSynergyControlResponse) {
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
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      try {
        finish(undefined, JSON.parse(line) as MetaSynergyControlResponse)
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

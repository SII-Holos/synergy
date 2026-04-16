import net from "node:net"
import { unlink } from "node:fs/promises"
import { MetaSynergyLog } from "../log"
import { MetaSynergyStore } from "../state/store"
import { ControlRequestSchema, type MetaSynergyControlRequest, type MetaSynergyControlResponse } from "./schema"

export class MetaSynergyControlServer {
  readonly socketPath: string
  readonly #handler: (request: MetaSynergyControlRequest) => Promise<unknown>
  #server: net.Server | null = null

  constructor(handler: (request: MetaSynergyControlRequest) => Promise<unknown>) {
    this.socketPath = MetaSynergyStore.controlSocketPath()
    this.#handler = handler
  }

  async start() {
    if (this.#server) return
    await MetaSynergyStore.ensureRoot()
    await unlink(this.socketPath).catch(() => undefined)
    this.#server = net.createServer((socket) => {
      socket.setEncoding("utf8")
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf("\n")
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void this.#handleLine(line, socket)
      })
      socket.on("error", (error) => {
        MetaSynergyLog.warn("control.socket.client.error", {
          error: error.message,
        })
      })
    })
    this.#server.on("error", (error) => {
      MetaSynergyLog.error("control.socket.server.error", {
        error: error.message,
        socketPath: this.socketPath,
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("listening", resolve)
      this.#server!.once("error", reject)
      this.#server!.listen(this.socketPath)
    })
    MetaSynergyLog.info("control.socket.server.started", {
      socketPath: this.socketPath,
    })
  }

  async stop() {
    const server = this.#server
    this.#server = null
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }).catch(() => undefined)
    }
    await unlink(this.socketPath).catch(() => undefined)
    MetaSynergyLog.info("control.socket.server.stopped", {
      socketPath: this.socketPath,
    })
  }

  async #handleLine(line: string, socket: net.Socket) {
    let response: MetaSynergyControlResponse
    try {
      const request = ControlRequestSchema.parse(JSON.parse(line))
      const payload = await this.#handler(request)
      response = { ok: true, payload }
    } catch (error) {
      response = {
        ok: false,
        error: {
          code: "control_request_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    socket.write(`${JSON.stringify(response)}\n`)
    socket.end()
  }
}

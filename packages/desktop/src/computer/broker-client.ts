import {
  COMPUTER_PROTOCOL_VERSION,
  COMPUTER_MAX_MESSAGE_BYTES,
  ComputerServerMessageSchema,
  ComputerError,
} from "@ericsanchezok/synergy-computer"
import { ComputerDriver } from "./driver.js"

export class ComputerBrokerClient {
  private socket?: WebSocket
  private driver?: ComputerDriver
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private readonly pending = new Map<string, AbortController>()
  constructor(
    private readonly options: { serverUrl: string; token: string; executable: string; checkPermissions(): void },
  ) {}
  connect() {
    if (this.closed || this.socket) return
    const url = new URL("/computer/host/broker", this.options.serverUrl)
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "register", version: COMPUTER_PROTOCOL_VERSION, token: this.options.token })),
    )
    socket.addEventListener("message", (event) => {
      void this.handle(socket, String(event.data)).catch(() => socket.close(1011, "Computer transport failed"))
    })
    socket.addEventListener("error", () => socket.close())
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return
      this.socket = undefined
      void this.cleanup()
        .catch(() => {})
        .finally(() => {
          if (!this.closed) this.timer = setTimeout(() => this.connect(), 1000)
        })
    })
  }
  private async handle(socket: WebSocket, raw: string) {
    if (socket !== this.socket || this.closed) return
    if (Buffer.byteLength(raw) > COMPUTER_MAX_MESSAGE_BYTES) {
      socket.close(1009)
      return
    }
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      socket.close(1008)
      return
    }
    const parsed = ComputerServerMessageSchema.safeParse(input)
    if (!parsed.success) {
      socket.close(1008)
      return
    }
    const message = parsed.data
    if (message.type === "registered") return
    if (message.type === "cancel") {
      this.pending.get(message.id)?.abort()
      return
    }
    if (this.pending.size >= 64 || this.pending.has(message.id)) {
      socket.close(1008)
      return
    }
    const abort = new AbortController()
    this.pending.set(message.id, abort)
    this.driver ??= new ComputerDriver(this.options.executable, this.options.checkPermissions)
    try {
      const result = await this.driver.execute(message.owner, message.command, abort.signal)
      if (this.socket === socket && socket.readyState === WebSocket.OPEN && !abort.signal.aborted) {
        const payload = JSON.stringify({ type: "result", id: message.id, result })
        if (Buffer.byteLength(payload) > COMPUTER_MAX_MESSAGE_BYTES)
          throw new ComputerError("computer_output_limit", "Computer output exceeds the transport limit.")
        socket.send(payload)
      }
    } catch (error) {
      if (this.socket === socket && socket.readyState === WebSocket.OPEN && !abort.signal.aborted)
        socket.send(
          JSON.stringify({
            type: "error",
            id: message.id,
            code: error instanceof ComputerError ? error.code : "computer_host_error",
            message: (error instanceof Error ? error.message : String(error)).slice(0, 20_000),
          }),
        )
    } finally {
      this.pending.delete(message.id)
    }
  }
  private async cleanup() {
    for (const abort of this.pending.values()) abort.abort()
    this.pending.clear()
    const driver = this.driver
    this.driver = undefined
    await driver?.close()
  }
  async close() {
    this.closed = true
    clearTimeout(this.timer)
    const socket = this.socket
    this.socket = undefined
    socket?.close()
    await this.cleanup()
  }
}

import { access } from "node:fs/promises"
import type { CuaDriver } from "@trycua/cua-driver"
import { ComputerError, type ComputerCommand } from "@ericsanchezok/synergy-computer"
import { ComputerRuntime } from "./runtime.js"

export class ComputerDriver {
  private client?: CuaDriver
  private connecting?: Promise<CuaDriver>
  private closed = false
  private readonly runtime: ComputerRuntime
  constructor(
    private readonly executable: string,
    private readonly checkPermissions: () => void,
  ) {
    this.runtime = new ComputerRuntime((name, args, signal) => this.call(name, args, signal))
  }
  async execute(owner: string, command: ComputerCommand, signal?: AbortSignal) {
    if (process.platform !== "darwin")
      throw new ComputerError("computer_platform_unsupported", "Native Computer Use currently supports macOS Desktop.")
    this.checkPermissions()
    return this.runtime.execute(owner, command, signal)
  }
  private async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const client = await this.connect()
    const deadline = AbortSignal.timeout(40_000)
    const options = { signal: signal ? AbortSignal.any([signal, deadline]) : deadline }
    try {
      const result = await client.callTool(name, JSON.stringify(args), options)
      const raw: unknown = JSON.parse(result.rawJson)
      return raw
    } catch (error) {
      if (this.client === client) {
        this.client = undefined
        this.runtime.reset()
        try {
          await client.shutdown({ signal: AbortSignal.timeout(2000) })
        } catch {
        } finally {
          client.uniffiDestroy()
        }
      }
      throw error
    }
  }

  private async connect(): Promise<CuaDriver> {
    if (this.closed) throw new ComputerError("computer_host_closed", "Computer host has closed.")
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = this.start()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }
  private async start(): Promise<CuaDriver> {
    try {
      await access(this.executable)
      const { CuaDriver, SessionPermissionMode } = await import("@trycua/cua-driver")
      if (this.closed) throw new Error("Computer host has closed.")
      // The official private worker owns its stdin lifecycle without a daemon
      // endpoint or the standalone installation's global PID file.
      // https://github.com/trycua/cua/blob/cua-driver-rs-v0.23.2/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md
      const client = CuaDriver.createPrivateWorker({
        binaryPath: this.executable,
        hostBundleId: "io.holosai.synergy",
        inheritStderr: false,
        environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" }],
        startupTimeoutMs: 10_000n,
        shutdownTimeoutMs: 2_000n,
        configuredDriver: {
          claudeCodeCompatibility: false,
          authorization: {
            allowedModes: [SessionPermissionMode.Unrestricted],
            compatibilityMode: SessionPermissionMode.Unrestricted,
            unrestrictedAcknowledged: true,
            maxSessionTtlSeconds: 3600n,
            maxIdleTtlSeconds: 300n,
          },
        },
      })
      if (!(client instanceof CuaDriver)) throw new Error("Cua returned an invalid native runtime.")
      this.client = client
      return client
    } catch (error) {
      throw new ComputerError(
        "computer_driver_unavailable",
        `Cannot start the native Computer driver: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  async close() {
    this.closed = true
    await this.connecting?.catch(() => undefined)
    const client = this.client
    this.client = undefined
    try {
      await client?.shutdown()
    } finally {
      client?.uniffiDestroy()
      this.runtime.reset()
    }
  }
}

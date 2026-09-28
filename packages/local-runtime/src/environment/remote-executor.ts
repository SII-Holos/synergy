import { z } from "zod"
import { EnvironmentSchema } from "@ericsanchezok/synergy-harness/environment/schema"
import { ExecutionProtocol, type Executor } from "@ericsanchezok/synergy-harness/environment/executor"
import { ExecutionConnection, type ExecutorConnection } from "./connection"
import { RemoteWorkspaceFiles } from "./remote-files"

export type { ExecutorConnection } from "./connection"

export class RemoteExecutor implements Executor {
  readonly files: RemoteWorkspaceFiles
  private readonly connection: ExecutionConnection
  constructor(connection: ExecutorConnection) {
    this.connection = new ExecutionConnection(connection)
    this.files = new RemoteWorkspaceFiles(this.connection)
  }

  private async request(method: string, route: string, body?: unknown) {
    return this.connection.json(method, route, body)
  }

  async start(request: ExecutionProtocol.Request) {
    return ExecutionProtocol.Status.parse(await this.request("POST", "/v1/operations", request))
  }
  async describe() {
    return ExecutionProtocol.Description.parse(await this.request("GET", "/v1/runtime"))
  }
  async prepareInputs(input: ExecutionProtocol.Inputs) {
    return ExecutionProtocol.PreparedInputs.parse(await this.request("POST", "/v1/inputs", input))
  }
  async discardInputs(id: string) {
    await this.request("DELETE", `/v1/inputs/${encodeURIComponent(ExecutionProtocol.ID.parse(id))}`)
  }
  async prepareSandbox(input: ExecutionProtocol.SandboxInput) {
    return ExecutionProtocol.Sandbox.parse(await this.request("POST", "/v1/sandbox", input))
  }
  async releaseSandbox(id: string) {
    await this.request("DELETE", `/v1/sandbox/${encodeURIComponent(id)}`)
  }
  async status(id: string) {
    const result = await this.request("GET", this.route(id))
    return result === undefined ? undefined : ExecutionProtocol.Status.parse(result)
  }
  async output(id: string, after: number, limit: number) {
    return z
      .array(ExecutionProtocol.Chunk)
      .parse(await this.request("GET", `${this.route(id)}/output?after=${after}&limit=${limit}`))
  }
  async stdin(id: string, data: Uint8Array, end = false) {
    await this.required("POST", `${this.route(id)}/stdin`, { data: Buffer.from(data).toString("base64"), end })
  }
  async resize(id: string, cols: number, rows: number) {
    await this.required("POST", `${this.route(id)}/resize`, { cols, rows })
  }
  async cancel(id: string, digest: string) {
    await this.required("POST", `${this.route(id)}/cancel`, { digest })
  }
  async release(id: string) {
    await this.required("POST", `${this.route(id)}/release`)
  }
  async health() {
    return z
      .object({ version: z.literal(ExecutionProtocol.version), target: EnvironmentSchema.Target })
      .parse(await this.request("GET", "/v1/status"))
  }

  private async required(method: string, route: string, body?: unknown) {
    const result = await this.request(method, route, body)
    if (result === undefined) throw new Error("Execution not found")
    return result
  }

  private route(id: string) {
    return `/v1/operations/${encodeURIComponent(ExecutionProtocol.ID.parse(id))}`
  }
}

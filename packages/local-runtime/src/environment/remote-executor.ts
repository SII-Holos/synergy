import { z } from "zod"
import { EnvironmentSchema } from "@ericsanchezok/synergy-harness/environment/schema"
import { ExecutionProtocol, type Executor } from "@ericsanchezok/synergy-harness/environment/executor"

export interface ExecutorConnection {
  url: string | URL
  target: EnvironmentSchema.Target
  token: string
  unix?: string
  tls?: Bun.TLSOptions
}

export class RemoteExecutor implements Executor {
  constructor(private readonly connection: ExecutorConnection) {}

  private async request(method: string, route: string, body?: unknown) {
    const response = await fetch(new URL(route, this.connection.url), {
      method,
      unix: this.connection.unix,
      tls: this.connection.tls,
      headers: {
        authorization: `Bearer ${this.connection.token}`,
        "x-synergy-target": JSON.stringify(this.connection.target),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    })
    if (response.status === 404) return undefined
    if (!response.ok)
      throw new Error(`Executor request failed (${response.status}): ${(await response.text()).slice(0, 1024)}`)
    return response.json() as Promise<unknown>
  }

  async start(request: ExecutionProtocol.Request) {
    return ExecutionProtocol.Status.parse(await this.request("POST", "/v1/operations", request))
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

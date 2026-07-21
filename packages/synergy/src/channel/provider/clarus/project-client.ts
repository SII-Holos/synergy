import z from "zod"
import { validateHolosEndpoint } from "@/holos/security"

const Project = z
  .object({
    project_id: z.string().min(1).max(512),
    title: z.string().max(512),
    status: z.string().max(128),
  })
  .passthrough()

const ProjectPage = z.object({
  items: z.array(Project).max(100),
  next_cursor: z.string().max(1024).nullable().optional(),
})

const ResponseEnvelope = z.object({
  code: z.number().int(),
  message: z.string().max(500).optional(),
  data: z.unknown(),
})

type Credential = {
  agentID: string
  agentSecret: string
}

export class ClarusProjectClient {
  private readonly origin: URL

  constructor(
    apiUrl: string,
    private readonly credentials: () => Promise<Credential | undefined>,
    private readonly signal: AbortSignal,
  ) {
    this.origin = validateHolosEndpoint(apiUrl, "api")
    if (this.origin.pathname !== "/" || this.origin.search || this.origin.hash) {
      throw new Error("Clarus API URL must be an origin")
    }
  }

  async listProjects(input: { cursor?: string; limit?: number } = {}) {
    const query = new URLSearchParams({ status: "active", limit: String(input.limit ?? 50) })
    if (input.cursor) query.set("cursor", input.cursor)
    const url = new URL("/api/v1/holos/clarus/projects", this.origin)
    url.search = query.toString()
    const data = await this.get(url)
    const page = ProjectPage.parse(data)
    return {
      projects: page.items.map((project) => ({
        projectID: project.project_id,
        projectName: project.title,
        status: project.status,
      })),
      nextCursor: page.next_cursor ?? undefined,
    }
  }

  private async get(url: URL): Promise<unknown> {
    const credential = await this.credentials()
    if (!credential?.agentID || !credential.agentSecret) throw new Error("Clarus credentials are unavailable")
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(15_000)])
    try {
      const response = await fetch(
        new Request(url, {
          method: "GET",
          redirect: "error",
          signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.agentSecret}`,
            "X-Agent-Id": credential.agentID,
          },
        }),
      )
      if (response.url && new URL(response.url).origin !== this.origin.origin) {
        throw new Error("Clarus redirect changed origin")
      }
      const body = await response.text()
      if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) {
        throw new Error("Clarus response body exceeds its limit")
      }
      const envelope = ResponseEnvelope.parse(JSON.parse(body))
      if (!response.ok || envelope.code !== 0) throw new Error("Clarus project request failed")
      return envelope.data
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Clarus")) throw error
      throw new Error("Clarus project request failed")
    }
  }
}

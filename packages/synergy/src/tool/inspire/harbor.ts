import { Log } from "../../util/log"
import { InspireAuth } from "./auth"
import { InspireTypes } from "./types"

export namespace InspireHarbor {
  const log = Log.create({ service: "inspire.harbor" })

  const BASE = `https://${InspireTypes.HARBOR_REGISTRY}/api/v2.0`
  const PROJECT = InspireTypes.HARBOR_PROJECT

  export interface HarborRepoInfo {
    name: string
    short_name: string
    description: string
    artifact_count: number
    pull_count: number
    update_time: string
  }

  export interface HarborArtifactInfo {
    tags: string[]
    size_bytes: number
    size_gb: number
    push_time: string
    digest: string
  }

  async function authHeader(): Promise<string> {
    const creds = await InspireAuth.getHarborCredentials()
    if (!creds) throw new Error("harbor_not_authenticated")
    return "Basic " + btoa(`${creds.username}:${creds.password}`)
  }

  function stripProjectPrefix(name: string): string {
    const prefix = `${PROJECT}/`
    return name.startsWith(prefix) ? name.slice(prefix.length) : name
  }

  export async function listRepositories(opts?: {
    search?: string
    limit?: number
    page?: number
  }): Promise<{ total: number; repositories: HarborRepoInfo[] }> {
    const limit = opts?.limit ?? 20
    const page = opts?.page ?? 1
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(limit),
      sort: "-update_time",
    })
    if (opts?.search) params.set("q", `name=~${opts.search}`)

    const url = `${BASE}/projects/${PROJECT}/repositories?${params}`
    log.info("listing repositories", { url })

    const resp = await fetch(url, {
      headers: { Authorization: await authHeader() },
    })
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Harbor API error ${resp.status}: ${body}`)
    }

    const total = parseInt(resp.headers.get("X-Total-Count") ?? "0", 10)
    const raw = (await resp.json()) as any[]

    const repositories: HarborRepoInfo[] = raw.map((r) => ({
      name: r.name,
      short_name: stripProjectPrefix(r.name),
      description: r.description ?? "",
      artifact_count: r.artifact_count ?? 0,
      pull_count: r.pull_count ?? 0,
      update_time: r.update_time ?? "",
    }))

    return { total, repositories }
  }

  export async function listArtifacts(repoName: string, opts?: { limit?: number }): Promise<HarborArtifactInfo[]> {
    const bare = stripProjectPrefix(repoName)
    const limit = opts?.limit ?? 50
    const url = `${BASE}/projects/${PROJECT}/repositories/${encodeURIComponent(bare)}/artifacts?page_size=${limit}`
    log.info("listing artifacts", { repo: bare })

    const resp = await fetch(url, {
      headers: { Authorization: await authHeader() },
    })
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Harbor API error ${resp.status}: ${body}`)
    }

    const raw = (await resp.json()) as any[]
    return raw.map((a) => {
      const sizeBytes = a.size ?? 0
      return {
        tags: (a.tags ?? []).map((t: any) => t.name),
        size_bytes: sizeBytes,
        size_gb: Math.round((sizeBytes / 1024 ** 3) * 10) / 10,
        push_time: a.push_time ?? "",
        digest: a.digest ?? "",
      }
    })
  }

  export async function setDescription(repoName: string, description: string): Promise<void> {
    const bare = stripProjectPrefix(repoName)
    const url = `${BASE}/projects/${PROJECT}/repositories/${encodeURIComponent(bare)}`
    log.info("updating description", { repo: bare })

    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: await authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description }),
    })
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Harbor API error ${resp.status}: ${body}`)
    }
  }

  export async function pushImage(opts: {
    localImage: string
    remoteName: string
    remoteTag: string
  }): Promise<{ fullPath: string; digest?: string }> {
    const creds = await InspireAuth.getHarborCredentials()
    if (!creds) throw new Error("harbor_not_authenticated")

    const registry = InspireTypes.HARBOR_REGISTRY
    const fullPath = `${registry}/${PROJECT}/${opts.remoteName}:${opts.remoteTag}`

    const hasDocker = await checkDocker()
    if (!hasDocker) throw new Error("docker is not installed or not in PATH")

    log.info("docker login", { registry })
    const loginProc = Bun.spawn(["docker", "login", registry, "-u", creds.username, "--password-stdin"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    })
    loginProc.stdin.write(creds.password)
    loginProc.stdin.end()
    const loginExit = await loginProc.exited
    const loginStderr = await new Response(loginProc.stderr).text()
    if (loginExit !== 0) throw new Error(`docker login failed: ${loginStderr}`)

    log.info("docker tag", { from: opts.localImage, to: fullPath })
    await exec(["docker", "tag", opts.localImage, fullPath])

    log.info("docker push", { image: fullPath })
    const pushOutput = await exec(["docker", "push", fullPath])

    let digest: string | undefined
    const digestMatch = pushOutput.match(/digest:\s*(sha256:[a-f0-9]+)/i)
    if (digestMatch) digest = digestMatch[1]

    return { fullPath, digest }
  }

  async function exec(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) throw new Error(stderr || stdout)
    return stdout
  }

  async function checkDocker(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["docker", "version", "--format", "{{.Client.Version}}"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      return (await proc.exited) === 0
    } catch {
      return false
    }
  }
}

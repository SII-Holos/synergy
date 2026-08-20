import { AgendaStore } from "./store"
import { AgendaTypes } from "./types"
import { Log } from "../util/log"
import { GitHubProvider } from "../provider/github"
import { Config } from "../config/config"

/**
 * GitHub agenda trigger — polls the GitHub REST API on a per-trigger interval
 * and fires agenda items when a watched PR / issue / workflow / check run
 * changes state.
 *
 * Mirrors the other agenda trigger sources: registrations are keyed by item,
 * each entry runs its own polling loop, and matches are forwarded to the
 * shared Agenda handler as a FiredSignal whose payload carries the resource
 * snapshot (number, state, URL, and resource-specific fields).
 *
 * Zero-cost when idle: entries with no resolved GitHub credential do not
 * schedule any poll, and the whole source is disabled when
 * `github.watch.enabled` is false in config (default: enabled).
 */
export namespace AgendaGithubTrigger {
  const log = Log.create({ service: "agenda.github-trigger" })

  const DEFAULT_INTERVAL_MS = 5 * 60_000
  const MIN_INTERVAL_MS = 30_000

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface Entry {
    itemID: string
    scopeID: string
    resource: "pr" | "issue" | "workflow" | "check"
    repository: string
    number?: number
    intervalMs: number
    states?: string[]
    timer?: Timer
    /** resource key → last observed state */
    lastStates: Map<string, string>
    /** First poll initializes baseline without firing. */
    primed: boolean
  }

  const entries = new Map<string, Entry[]>()
  let handler: Handler | null = null
  let started = false

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    handler = onFire
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers)
    }
    started = true
    log.info("started", { entries: countEntries() })
  }

  export function stop(): void {
    for (const list of entries.values()) {
      for (const entry of list) cancelTimer(entry)
    }
    entries.clear()
    started = false
    handler = null
  }

  export function register(itemID: string, scopeID: string, triggers: AgendaTypes.Trigger[]): void {
    unregister(itemID)
    const created: Entry[] = []
    for (const trigger of triggers) {
      if (trigger.type !== "github") continue
      const intervalMs = Math.max(
        MIN_INTERVAL_MS,
        trigger.interval ? AgendaStore.parseDuration(trigger.interval) : DEFAULT_INTERVAL_MS,
      )
      created.push({
        itemID,
        scopeID,
        resource: trigger.resource,
        repository: trigger.repository,
        number: trigger.number,
        intervalMs,
        states: trigger.states,
        lastStates: new Map(),
        primed: false,
      })
    }
    if (created.length > 0) {
      entries.set(itemID, created)
      if (started) for (const entry of created) schedule(entry, 0)
    }
  }

  export function unregister(itemID: string): void {
    const list = entries.get(itemID)
    if (!list) return
    for (const entry of list) cancelTimer(entry)
    entries.delete(itemID)
  }

  export function active(): { items: number; entries: number } {
    return { items: entries.size, entries: countEntries() }
  }

  function countEntries(): number {
    let n = 0
    for (const list of entries.values()) n += list.length
    return n
  }

  function cancelTimer(entry: Entry) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  function schedule(entry: Entry, delayMs: number) {
    cancelTimer(entry)
    entry.timer = setTimeout(() => void poll(entry), delayMs)
  }

  async function watchEnabled(): Promise<boolean> {
    const cfg = (await Config.globalResolved().catch(() => undefined))?.github?.watch
    return cfg?.enabled !== false
  }

  async function poll(entry: Entry) {
    entry.timer = undefined
    try {
      if (!(await watchEnabled())) {
        schedule(entry, entry.intervalMs)
        return
      }
      const resolved = await GitHubProvider.resolveToken()
      if (!resolved?.token) {
        // No credential: stay silent, retry at the normal cadence.
        schedule(entry, entry.intervalMs)
        return
      }
      const snapshots = await fetchSnapshots(entry, resolved.token)
      for (const snapshot of snapshots) {
        const key = snapshotKey(entry, snapshot.number)
        const previous = entry.lastStates.get(key)
        entry.lastStates.set(key, snapshot.state)
        if (!entry.primed) continue
        if (previous === snapshot.state) continue
        if (entry.states && !entry.states.includes(snapshot.state)) continue
        fire(entry, snapshot, previous)
      }
      entry.primed = true
    } catch (error) {
      log.warn("github poll failed", {
        itemID: entry.itemID,
        repository: entry.repository,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      schedule(entry, entry.intervalMs)
    }
  }

  function fire(entry: Entry, snapshot: ResourceSnapshot, previous: string | undefined) {
    if (!handler) return
    const signal: AgendaTypes.FiredSignal = {
      type: "github",
      source: entry.itemID,
      payload: {
        resource: entry.resource,
        repository: entry.repository,
        number: snapshot.number,
        title: snapshot.title,
        state: snapshot.state,
        previousState: previous,
        url: snapshot.url,
        ...(snapshot.conclusion !== undefined ? { conclusion: snapshot.conclusion } : {}),
        ...(snapshot.draft !== undefined ? { draft: snapshot.draft } : {}),
        ...(snapshot.mergeable !== undefined ? { mergeable: snapshot.mergeable } : {}),
        ...(snapshot.updatedAt !== undefined ? { updatedAt: snapshot.updatedAt } : {}),
      },
      timestamp: Date.now(),
    }
    handler(signal, entry.scopeID).catch((err) => {
      log.error("github trigger handler failed", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })
  }

  function snapshotKey(entry: Entry, number: number): string {
    return `${entry.resource}:${number}`
  }

  // ---------------------------------------------------------------------------
  // GitHub REST polling
  // ---------------------------------------------------------------------------

  interface ResourceSnapshot {
    number: number
    title?: string
    state: string
    url?: string
    conclusion?: string
    draft?: boolean
    mergeable?: boolean
    updatedAt?: string
  }

  async function api(path: string, token: string): Promise<any> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": GitHubProvider.USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`GitHub API ${path} failed with status ${response.status}`)
    }
    return response.json()
  }

  async function fetchSnapshots(entry: Entry, token: string): Promise<ResourceSnapshot[]> {
    const [owner, repo] = entry.repository.split("/")
    switch (entry.resource) {
      case "pr": {
        if (entry.number !== undefined) {
          const pr = await api(`/repos/${owner}/${repo}/pulls/${entry.number}`, token)
          return [prSnapshot(pr)]
        }
        const list = await api(`/repos/${owner}/${repo}/pulls?state=all&per_page=10&sort=updated&direction=desc`, token)
        return (Array.isArray(list) ? list : []).map(prSnapshot)
      }
      case "issue": {
        if (entry.number !== undefined) {
          const issue = await api(`/repos/${owner}/${repo}/issues/${entry.number}`, token)
          return [issueSnapshot(issue)]
        }
        const list = await api(
          `/repos/${owner}/${repo}/issues?state=all&per_page=10&sort=updated&direction=desc`,
          token,
        )
        return (Array.isArray(list) ? list : []).filter((i: any) => i.pull_request === undefined).map(issueSnapshot)
      }
      case "workflow": {
        if (entry.number !== undefined) {
          const run = await api(`/repos/${owner}/${repo}/actions/runs/${entry.number}`, token)
          const payload = run.workflow_run ?? run
          return [workflowSnapshot(payload)]
        }
        const list = await api(`/repos/${owner}/${repo}/actions/runs?per_page=10`, token)
        return (Array.isArray(list.workflow_runs) ? list.workflow_runs : []).map(workflowSnapshot)
      }
      case "check": {
        const list = await api(
          `/repos/${owner}/${repo}/commits/${entry.number ?? "HEAD"}/check-runs?per_page=20`,
          token,
        )
        return (Array.isArray(list.check_runs) ? list.check_runs : []).map(checkSnapshot)
      }
    }
  }

  function prSnapshot(pr: any): ResourceSnapshot {
    const state = pr.merged ? "merged" : pr.draft ? "draft" : pr.state
    return {
      number: pr.number,
      title: pr.title,
      state,
      url: pr.html_url,
      draft: pr.draft === true,
      mergeable: pr.mergeable === null ? undefined : pr.mergeable,
      updatedAt: pr.updated_at,
    }
  }

  function issueSnapshot(issue: any): ResourceSnapshot {
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      updatedAt: issue.updated_at,
    }
  }

  function workflowSnapshot(run: any): ResourceSnapshot {
    const state = run.status === "completed" ? (run.conclusion ?? "completed") : run.status
    return {
      number: run.id,
      title: run.name,
      state,
      conclusion: run.conclusion,
      updatedAt: run.updated_at,
    }
  }

  function checkSnapshot(check: any): ResourceSnapshot {
    const state = check.status === "completed" ? (check.conclusion ?? "completed") : check.status
    return {
      number: check.id,
      title: check.name,
      state,
      url: check.html_url,
      conclusion: check.conclusion,
      updatedAt: check.started_at,
    }
  }
}

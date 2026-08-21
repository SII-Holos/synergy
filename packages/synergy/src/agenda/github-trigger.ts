import { AgendaSessionWakeup } from "./session-wakeup"
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
 * - Zero-cost when idle: entries with no resolved GitHub credential make no
 *   API call, and the whole source goes quiet when `github.watch.enabled` is
 *   false in config (default: enabled).
 * - Triggers without an explicit `interval` fall back to the configured
 *   `github.watch.defaultIntervalMs` (default 5 minutes, floor 30 seconds).
 * - Multiple transitions observed in one poll are dispatched sequentially so
 *   the Agenda inflight guard cannot drop later transitions.
 * - Repeated poll failures (unreachable repo, revoked token) auto-pause the
 *   item instead of retrying forever.
 */
export namespace AgendaGithubTrigger {
  const log = Log.create({ service: "agenda.github-trigger" })

  const DEFAULT_INTERVAL_MS = 5 * 60_000
  const MIN_INTERVAL_MS = 30_000
  const MAX_CONSECUTIVE_FAILURES = 5
  /** Bounded recent baseline: repository-wide watches must not accumulate
   *  every observed resource ID for the lifetime of the trigger. */
  const MAX_BASELINE_ENTRIES = 256

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface Entry {
    itemID: string
    scopeID: string
    resource: "pr" | "issue" | "workflow" | "check"
    repository: string
    number?: number
    ref?: string
    /** Explicit trigger interval; undefined falls back to the configured default. */
    intervalMs?: number
    states?: string[]
    timer?: Timer
    /** resource key → last observed state */
    lastStates: Map<string, string>
    /**
     * Whether first observations of a targeted state may fire. True for
     * newly created items; false during the first restore poll of a
     * previously-run item (so a restart re-baselines silently), then flipped
     * true after that baseline so genuinely new resources are reported again.
     */
    allowInitialMatch: boolean
    consecutiveFailures: number
    /** Serializes handler dispatch so concurrent transitions run in order
     *  instead of racing the Agenda inflight guard. */
    dispatch: Promise<void>
  }

  const entries = new Map<string, Entry[]>()
  let handler: Handler | null = null
  let started = false

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    handler = onFire
    // Arm before registering: register() only schedules while started, and
    // items restored from storage at startup must begin polling immediately.
    started = true
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers, { hasRun: item.state.runCount > 0 })
    }
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

  export function register(
    itemID: string,
    scopeID: string,
    triggers: AgendaTypes.Trigger[],
    opts: { hasRun?: boolean } = {},
  ): void {
    unregister(itemID)
    const created: Entry[] = []
    for (const trigger of triggers) {
      if (trigger.type !== "github") continue
      created.push({
        itemID,
        scopeID,
        resource: trigger.resource,
        repository: trigger.repository,
        number: trigger.number,
        ref: trigger.ref,
        intervalMs: trigger.interval ? AgendaStore.parseDuration(trigger.interval) : undefined,
        states: trigger.states,
        lastStates: new Map(),
        // Only items that have never run may report an already-satisfied
        // target state on first observation; restored items re-baseline
        // silently so restarts do not re-notify.
        allowInitialMatch: opts.hasRun !== true,
        consecutiveFailures: 0,
        dispatch: Promise.resolve(),
      })
    }
    if (created.length > 0) {
      entries.set(itemID, created)
      log.info("github trigger registered", {
        itemID,
        entries: created.length,
        resource: created[0]?.resource,
        repository: created[0]?.repository,
        started,
      })
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

  async function watchConfig(): Promise<{ enabled: boolean; defaultIntervalMs?: number }> {
    const cfg = (await Config.globalResolved().catch(() => undefined))?.github?.watch
    return { enabled: cfg?.enabled !== false, defaultIntervalMs: cfg?.defaultIntervalMs }
  }

  async function poll(entry: Entry) {
    entry.timer = undefined
    let configuredDefaultMs: number | undefined
    let abandoned = false
    try {
      const watch = await watchConfig()
      configuredDefaultMs = watch.defaultIntervalMs
      if (!watch.enabled) {
        // Polling was switched off after this item was created: pause it now
        // (releasing any continuation holding it) instead of idling forever.
        abandoned = true
        await pauseDisabled(entry)
        return
      }
      const resolved = await GitHubProvider.resolveToken()
      if (!resolved?.token) {
        // No credential: stay silent, retry at the normal cadence.
        return
      }
      const snapshots = await fetchSnapshots(entry, resolved.token)
      const changes = collectChanges(entry, snapshots)
      // The first poll after a restart is the restore baseline: it must not
      // fire for already-satisfied states, but after it completes, first
      // observations of genuinely new resources may fire again.
      entry.allowInitialMatch = true
      for (const change of changes) {
        entry.dispatch = entry.dispatch.then(() => fire(entry, change.snapshot, change.previous))
      }
      entry.consecutiveFailures = 0
    } catch (error) {
      entry.consecutiveFailures++
      log.warn("github poll failed", {
        itemID: entry.itemID,
        repository: entry.repository,
        consecutiveFailures: entry.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      })
      if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        abandoned = true
        await pauseAfterFailures(entry)
      }
    } finally {
      // Never reschedule a detached entry: unregister()/stop() may have run
      // while the poll request was in flight.
      if (!abandoned && started && entries.get(entry.itemID)?.includes(entry)) {
        const intervalMs = entry.intervalMs ?? configuredDefaultMs ?? DEFAULT_INTERVAL_MS
        schedule(entry, Math.max(MIN_INTERVAL_MS, intervalMs))
      }
    }
  }

  /** Pause an item whose polling was disabled in config after creation. */
  async function pauseDisabled(entry: Entry): Promise<void> {
    unregister(entry.itemID)
    try {
      const before = await AgendaStore.get(entry.scopeID, entry.itemID)
      const item = await AgendaStore.update(entry.scopeID, entry.itemID, { status: "paused" })
      await AgendaSessionWakeup.resumeIfReleased({ before, after: item })
    } catch (err) {
      log.error("failed to pause github trigger after watch was disabled", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
    log.warn("github trigger paused because github.watch.enabled=false", {
      itemID: entry.itemID,
      repository: entry.repository,
    })
  }

  async function pauseAfterFailures(entry: Entry): Promise<void> {
    unregister(entry.itemID)
    try {
      const before = await AgendaStore.get(entry.scopeID, entry.itemID)
      const item = await AgendaStore.update(entry.scopeID, entry.itemID, { status: "paused" })
      // Pausing a continuation-holding watch must release the waiting
      // session (Light Loop / BlueprintLoop) — the same release hook Agenda
      // pause/cancel use — or the session stays stopped forever.
      await AgendaSessionWakeup.resumeIfReleased({ before, after: item })
    } catch (err) {
      log.error("failed to pause github trigger after repeated failures", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
    log.warn("github trigger auto-paused after repeated poll failures", {
      itemID: entry.itemID,
      repository: entry.repository,
    })
  }

  function fire(entry: Entry, snapshot: ResourceSnapshot, previous: string | undefined): Promise<void> {
    if (!handler) return Promise.resolve()
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
    return handler(signal, entry.scopeID).catch((err) => {
      log.error("github trigger handler failed", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })
  }

  /**
   * Diff snapshots against the entry baseline and return the transitions that
   * should fire, in observation order. The baseline always advances (even for
   * filtered-out transitions) so `previousState` reflects the last seen state.
   *
   * The baseline key is `state` for PR/issue watches and `state:conclusion`
   * for workflow/check watches, so a run finishing (`completed` →
   * `completed:failure`) counts as a transition and the states filter can
   * match both the run status ("completed") and the conclusion ("success",
   * "failure") as documented.
   *
   * First observation of a resource (`previous === undefined`): a
   * state-targeted watch reports immediately when the resource already sits
   * in a targeted state — covering watches created for an already-satisfied
   * condition and races where the state changed between item creation and the
   * first poll. Watches without a states filter stay silent on first
   * observation so repository-wide watchers do not fire on creation.
   * `allowInitialMatch` gates this to items that have never run, so a
   * restart re-baselines silently instead of re-notifying.
   */
  export function collectChanges(
    entry: Pick<Entry, "lastStates" | "allowInitialMatch" | "states">,
    snapshots: ResourceSnapshot[],
  ): Array<{ snapshot: ResourceSnapshot; previous: string | undefined }> {
    const pending: Array<{ snapshot: ResourceSnapshot; previous: string | undefined }> = []
    for (const snapshot of snapshots) {
      const key = `${snapshot.resource ?? ""}:${snapshot.number}`
      const filterKey = snapshotKey(snapshot)
      const previous = entry.lastStates.get(key)
      entry.lastStates.set(key, filterKey)
      // Bound the baseline: repository-wide watches observe new resource IDs
      // every poll; drop the oldest entry once the cap is exceeded so long
      // running servers do not accumulate unbounded memory.
      if (entry.lastStates.size > MAX_BASELINE_ENTRIES) {
        const oldest = entry.lastStates.keys().next().value
        if (oldest !== undefined) entry.lastStates.delete(oldest)
      }
      if (previous === undefined) {
        // First observation: only a state-targeted watch may report an
        // already-satisfied condition; unfiltered watches baseline silently.
        if (entry.allowInitialMatch && entry.states !== undefined && matchesStates(entry.states, snapshot)) {
          pending.push({ snapshot, previous: undefined })
        }
        continue
      }
      if (previous === filterKey) continue
      if (!matchesStates(entry.states, snapshot)) continue
      pending.push({ snapshot, previous })
    }
    return pending
  }

  /** Baseline key combining run status and conclusion for workflow/check runs. */
  function snapshotKey(snapshot: ResourceSnapshot): string {
    return snapshot.conclusion !== undefined ? `${snapshot.state}:${snapshot.conclusion}` : snapshot.state
  }

  /** Whether a transition matches the configured states filter (status or conclusion). */
  function matchesStates(states: string[] | undefined, snapshot: ResourceSnapshot): boolean {
    if (!states) return true
    return (
      states.includes(snapshot.state) || (snapshot.conclusion !== undefined && states.includes(snapshot.conclusion))
    )
  }
  // ---------------------------------------------------------------------------
  // GitHub REST polling
  // ---------------------------------------------------------------------------

  export interface ResourceSnapshot {
    resource?: "pr" | "issue" | "workflow" | "check"
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
        // The issues list mixes PRs into the newest page; fetch several pages
        // so filtering PRs out still leaves the intended issue window even in
        // PR-heavy repositories.
        const pages = await Promise.all(
          [1, 2, 3].map((page) =>
            api(`/repos/${owner}/${repo}/issues?state=all&per_page=30&sort=updated&direction=desc&page=${page}`, token),
          ),
        )
        return pages
          .flatMap((page) => (Array.isArray(page) ? page : []))
          .filter((i: any) => i.pull_request === undefined)
          .slice(0, 10)
          .map(issueSnapshot)
      }
      case "workflow": {
        if (entry.number !== undefined) {
          const run = await api(`/repos/${owner}/${repo}/actions/runs/${entry.number}`, token)
          const payload = run.workflow_run ?? run
          return [workflowSnapshot(payload)]
        }
        const branch = entry.ref ? `&branch=${encodeURIComponent(entry.ref)}` : ""
        const list = await api(`/repos/${owner}/${repo}/actions/runs?per_page=10${branch}`, token)
        return (Array.isArray(list.workflow_runs) ? list.workflow_runs : []).map(workflowSnapshot)
      }
      case "check": {
        const ref = encodeURIComponent(entry.ref ?? "HEAD")
        const list = await api(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=20`, token)
        return (Array.isArray(list.check_runs) ? list.check_runs : []).map(checkSnapshot)
      }
    }
  }

  export function prSnapshot(pr: any): ResourceSnapshot {
    // List responses expose merge completion via merged_at; the single-PR
    // response additionally carries a merged boolean. A draft PR closed
    // without being marked ready still reports draft:true alongside
    // state:"closed" — the terminal closed state must win over draft.
    const merged = pr.merged === true || typeof pr.merged_at === "string"
    const state = merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : pr.state
    return {
      resource: "pr",
      number: pr.number,
      title: pr.title,
      state,
      url: pr.html_url,
      draft: pr.draft === true,
      mergeable: pr.mergeable === null ? undefined : pr.mergeable,
      updatedAt: pr.updated_at,
    }
  }

  export function issueSnapshot(issue: any): ResourceSnapshot {
    return {
      resource: "issue",
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      updatedAt: issue.updated_at,
    }
  }

  /** Workflow state is the run status; the conclusion is carried separately. */
  export function workflowSnapshot(run: any): ResourceSnapshot {
    return {
      resource: "workflow",
      number: run.id,
      title: run.name,
      state: run.status,
      url: run.html_url,
      // GitHub returns null for in-progress runs; normalize to undefined so
      // baseline keys and payloads treat "no conclusion yet" consistently.
      conclusion: run.conclusion ?? undefined,
      updatedAt: run.updated_at,
    }
  }

  /** Check state is the check status; the conclusion is carried separately. */
  export function checkSnapshot(check: any): ResourceSnapshot {
    return {
      resource: "check",
      number: check.id,
      title: check.name,
      state: check.status,
      url: check.html_url,
      conclusion: check.conclusion ?? undefined,
      updatedAt: check.started_at,
    }
  }
}

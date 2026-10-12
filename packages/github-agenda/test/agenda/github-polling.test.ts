import { expect, spyOn, test } from "bun:test"
import { AgendaStore, type AgendaTypes } from "@ericsanchezok/synergy-agenda/agenda"
import { GithubWatchPolicy } from "@ericsanchezok/synergy-agenda/agenda/github-watch-policy"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { AgendaGithubTrigger } from "../../src/github-trigger"
import { testRuntime } from "../support/runtime"

function interceptFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(handler, { preconnect: fetch.preconnect }))
}

async function watch(
  trigger: Extract<AgendaTypes.Trigger, { type: "github" }>,
  run: (entry: AgendaGithubTrigger.Entry, signals: AgendaTypes.FiredSignal[]) => Promise<void>,
) {
  await using runtime = await testRuntime({ GH_TOKEN: "fixture-token", GITHUB_TOKEN: undefined })
  await runtime.run(async () => {
    const dispose = GithubWatchPolicy.register(async () => ({ enabled: true }))
    const signals: AgendaTypes.FiredSignal[] = []
    try {
      await using tmp = await tmpdir({})
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const item = await AgendaStore.create({
            title: "Watch fixture",
            prompt: "check",
            triggers: [trigger],
            createdBy: "agent",
          })
          AgendaGithubTrigger.start(async (signal, scopeID) => {
            expect(scopeID).toBe(item.origin.scope.id)
            signals.push(signal)
          }, [])
          AgendaGithubTrigger.register(item.id, item.origin.scope.id, item.triggers)
          const entry = AgendaGithubTrigger.entriesFor(item.id)[0]!
          clearTimeout(entry.timer)
          entry.timer = undefined
          await run(entry, signals)
        },
      })
    } finally {
      AgendaGithubTrigger.stop()
      dispose()
    }
  })
}

async function poll(entry: AgendaGithubTrigger.Entry) {
  clearTimeout(entry.timer)
  await AgendaGithubTrigger.poll(entry)
  await entry.dispatch
}

const repository = "owner/repo"
const pull = {
  number: 42,
  title: "Change",
  state: "closed",
  merged: true,
  draft: false,
  mergeable: true,
  html_url: "https://github.com/owner/repo/pull/42",
  updated_at: "2026-10-12T00:00:00Z",
}
const issue = { number: 43, title: "Issue", state: "closed", html_url: "https://github.com/owner/repo/issues/43" }
const run = {
  id: 44,
  name: "CI",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/owner/repo/actions/runs/44",
}
const check = { id: 45, name: "Check", status: "completed", conclusion: "success" }

test.each([
  {
    resource: "pr" as const,
    number: 42,
    path: "/pulls/42",
    body: pull,
    expected: { number: 42, state: "merged", draft: false, mergeable: true, updatedAt: pull.updated_at },
  },
  {
    resource: "pr" as const,
    path: "/pulls?state=all&per_page=10&sort=updated&direction=desc",
    body: [pull],
    expected: { number: 42, state: "merged" },
  },
  {
    resource: "issue" as const,
    number: 43,
    path: "/issues/43",
    body: issue,
    expected: { number: 43, state: "closed" },
  },
  {
    resource: "workflow" as const,
    number: 44,
    path: "/actions/runs/44",
    body: { workflow_run: run },
    expected: { number: 44, state: "completed", conclusion: "success" },
  },
  {
    resource: "workflow" as const,
    ref: "topic/one",
    path: "/actions/runs?per_page=10&branch=topic%2Fone",
    body: { workflow_runs: [run] },
    expected: { number: 44, state: "completed", conclusion: "success" },
  },
  {
    resource: "check" as const,
    ref: "topic/one",
    path: "/commits/topic%2Fone/check-runs?per_page=20",
    body: { check_runs: [check] },
    expected: { number: 45, state: "completed", conclusion: "success" },
  },
])("selected GitHub watch polls $path and dispatches one matching signal", async (fixture) => {
  const fetcher = interceptFetch(async (input, init) => {
    expect(String(input)).toBe(`https://api.github.com/repos/${repository}${fixture.path}`)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return Response.json(fixture.body)
  })
  try {
    await watch(
      {
        type: "github",
        resource: fixture.resource,
        repository,
        number: fixture.number,
        ref: fixture.ref,
        states: ["merged", "closed", "success"],
      },
      async (entry, signals) => {
        await poll(entry)
        expect(signals).toHaveLength(1)
        expect(signals[0]).toMatchObject({
          type: "github",
          source: entry.itemID,
          payload: { repository, resource: fixture.resource, ...fixture.expected },
        })
        await poll(entry)
        expect(signals).toHaveLength(1)
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(entry.timer).toBeDefined()
      },
    )
  } finally {
    fetcher.mockRestore()
  }
})

test("repository issue polling filters pull requests across pages", async () => {
  const pages: number[] = []
  const fetcher = interceptFetch(async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"))
    pages.push(page)
    return Response.json(page === 1 ? [{ ...pull, pull_request: {} }] : page === 2 ? [issue] : [])
  })
  try {
    await watch({ type: "github", resource: "issue", repository, states: ["closed"] }, async (entry, signals) => {
      await poll(entry)
      expect(pages.sort()).toEqual([1, 2, 3])
      expect(signals.map((signal) => signal.payload?.number)).toEqual([43])
    })
  } finally {
    fetcher.mockRestore()
  }
})

test("repeated GitHub failures pause durable Agenda state and stop polling", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }))
  try {
    await watch({ type: "github", resource: "pr", repository, number: 42 }, async (entry, signals) => {
      for (let attempt = 0; attempt < 4; attempt++) await poll(entry)
      expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("active")
      await poll(entry)
      expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("paused")
      expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
      expect(entry.timer).toBeUndefined()
      expect(signals).toEqual([])
      expect(fetcher).toHaveBeenCalledTimes(5)
    })
  } finally {
    fetcher.mockRestore()
  }
})

test("stopping a selected bridge suppresses a late response and its next timer", async () => {
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const fetcher = interceptFetch(async () => {
    entered.resolve()
    return response.promise
  })
  try {
    await watch(
      { type: "github", resource: "pr", repository, number: 42, states: ["merged"] },
      async (entry, signals) => {
        const pending = poll(entry)
        await entered.promise
        AgendaGithubTrigger.stop()
        response.resolve(Response.json(pull))
        await pending
        expect(signals).toEqual([])
        expect(entry.timer).toBeUndefined()
        expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
      },
    )
  } finally {
    response.resolve(Response.json(pull))
    fetcher.mockRestore()
  }
})

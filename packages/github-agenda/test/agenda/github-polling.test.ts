import { expect, spyOn, test } from "bun:test"
import { AgendaStore, type AgendaTypes } from "@ericsanchezok/synergy-agenda/agenda"
import { GithubWatchPolicy } from "@ericsanchezok/synergy-agenda/agenda/github-watch-policy"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { GitHubProvider } from "@ericsanchezok/synergy-harness/provider/github"
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

test("disconnecting GitHub pauses a saved watch after the credential grace period without making requests", async () => {
  await watch({ type: "github", resource: "pr", repository, number: 42 }, async (entry, signals) => {
    using credential = spyOn(GitHubProvider, "resolveToken").mockResolvedValue(undefined)
    using fetcher = spyOn(globalThis, "fetch")
    for (let attempt = 0; attempt < 4; attempt++) await poll(entry)
    expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("active")
    await poll(entry)
    expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("paused")
    expect(signals).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(entry.timer).toBeUndefined()
    expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
  })
})

test("disabling GitHub polling pauses existing watches and removes their timers", async () => {
  await watch({ type: "github", resource: "pr", repository, number: 42 }, async (entry, signals) => {
    const restore = GithubWatchPolicy.register(async () => ({ enabled: false }))
    using fetcher = spyOn(globalThis, "fetch")
    try {
      await poll(entry)
      expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("paused")
      expect(signals).toEqual([])
      expect(fetcher).not.toHaveBeenCalled()
      expect(entry.timer).toBeUndefined()
      expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
    } finally {
      restore()
    }
  })
})

test("restarting a previously run watch establishes a baseline before reporting a later transition", async () => {
  let merged = true
  using fetcher = interceptFetch(async () => Response.json({ ...pull, merged, state: merged ? "closed" : "open" }))
  await watch(
    { type: "github", resource: "pr", repository, number: 42, states: ["merged"] },
    async (entry, signals) => {
      const saved = await AgendaStore.get(entry.scopeID, entry.itemID)
      AgendaGithubTrigger.stop()
      AgendaGithubTrigger.start(
        async (signal) => {
          signals.push(signal)
        },
        [{ ...saved, state: { ...saved.state, runCount: 1 } }],
      )
      const restored = AgendaGithubTrigger.entriesFor(entry.itemID)[0]!
      await poll(restored)
      expect(signals).toEqual([])
      merged = false
      await poll(restored)
      expect(signals).toEqual([])
      merged = true
      await poll(restored)
      expect(signals).toHaveLength(1)
      expect(signals[0].payload).toMatchObject({ state: "merged", previousState: "open" })
      expect(restored.timer).toBeDefined()
    },
  )
})

test("one failed signal handler does not block the next GitHub transition", async () => {
  let state = "open"
  using fetcher = interceptFetch(async () => Response.json({ ...pull, merged: state === "merged", state }))
  await watch({ type: "github", resource: "pr", repository, number: 42 }, async (entry, signals) => {
    const saved = await AgendaStore.get(entry.scopeID, entry.itemID)
    AgendaGithubTrigger.stop()
    AgendaGithubTrigger.start(
      async (signal) => {
        signals.push(signal)
        if (signals.length === 1) throw new Error("Fixture handler failed")
      },
      [saved],
    )
    const current = AgendaGithubTrigger.entriesFor(entry.itemID)[0]!
    await poll(current)
    state = "closed"
    await poll(current)
    state = "merged"
    await poll(current)
    expect(signals.map((signal) => signal.payload?.state)).toEqual(["closed", "merged"])
    expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("active")
    expect(current.timer).toBeDefined()
  })
})

test("failed pause persistence preserves saved work and stops further polling", async () => {
  await watch({ type: "github", resource: "pr", repository, number: 42 }, async (entry, signals) => {
    const before = await AgendaStore.get(entry.scopeID, entry.itemID)
    const restore = GithubWatchPolicy.register(async () => ({ enabled: false }))
    using write = spyOn(AgendaStore, "update").mockRejectedValueOnce(new Error("Fixture storage unavailable"))
    try {
      await poll(entry)
      expect(write).toHaveBeenCalledTimes(1)
      expect(await AgendaStore.get(entry.scopeID, entry.itemID)).toEqual(before)
      expect(signals).toEqual([])
      expect(entry.timer).toBeUndefined()
    } finally {
      restore()
    }
  })
})

for (const action of ["unregister", "restart"] as const)
  test(`${action} suppresses an in-flight response from an obsolete watch`, async () => {
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    using fetcher = interceptFetch(async () => {
      entered.resolve()
      return response.promise
    })
    await watch(
      { type: "github", resource: "pr", repository, number: 42, states: ["merged"] },
      async (entry, signals) => {
        const pending = poll(entry)
        try {
          await entered.promise
          AgendaGithubTrigger.unregister(entry.itemID)
          if (action === "restart") {
            const saved = await AgendaStore.get(entry.scopeID, entry.itemID)
            AgendaGithubTrigger.stop()
            AgendaGithubTrigger.start(
              async (signal) => {
                signals.push(signal)
              },
              [saved],
            )
            const replacement = AgendaGithubTrigger.entriesFor(entry.itemID)[0]!
            clearTimeout(replacement.timer)
            replacement.timer = undefined
          }
          response.resolve(Response.json(pull))
          await pending
          expect(signals).toEqual([])
          expect(entry.timer).toBeUndefined()
          expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("active")
        } finally {
          response.resolve(Response.json(pull))
          await pending
        }
      },
    )
  })

for (const action of ["unregister", "stop"] as const)
  test(`${action} suppresses remaining signals already queued by the current poll`, async () => {
    using fetcher = interceptFetch(async () => Response.json([pull, { ...pull, number: 46 }]))
    await watch({ type: "github", resource: "pr", repository, states: ["merged"] }, async (entry, signals) => {
      const saved = await AgendaStore.get(entry.scopeID, entry.itemID)
      AgendaGithubTrigger.stop()
      AgendaGithubTrigger.start(
        async (signal) => {
          signals.push(signal)
          if (action === "stop") AgendaGithubTrigger.stop()
          else AgendaGithubTrigger.unregister(entry.itemID)
        },
        [saved],
      )
      const current = AgendaGithubTrigger.entriesFor(entry.itemID)[0]!
      await poll(current)
      expect(signals).toHaveLength(1)
      expect(signals[0].payload?.number).toBe(42)
      expect(current.timer).toBeUndefined()
      expect(AgendaGithubTrigger.active()).toEqual({ items: 0, entries: 0 })
      expect((await AgendaStore.get(entry.scopeID, entry.itemID)).status).toBe("active")
    })
  })

test("a stopped poll settles after its Runtime closes without entering another Runtime", async () => {
  await using runtime = await testRuntime({ GH_TOKEN: "fixture-token", GITHUB_TOKEN: undefined })
  await using survivor = await testRuntime()
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const signals: AgendaTypes.FiredSignal[] = []
  using fetcher = interceptFetch(async () => {
    entered.resolve()
    return response.promise
  })
  const triggers: AgendaTypes.Trigger[] = [
    { type: "github", resource: "pr", repository, number: 42, states: ["merged"] },
  ]
  await survivor.run(() => AgendaGithubTrigger.register("surviving-watch", "home", triggers))
  const { pending, entry } = await runtime.run(() => {
    GithubWatchPolicy.register(async () => ({ enabled: true }))
    AgendaGithubTrigger.start(async (signal) => {
      signals.push(signal)
    }, [])
    AgendaGithubTrigger.register("closing-watch", "home", triggers)
    const entry = AgendaGithubTrigger.entriesFor("closing-watch")[0]!
    const pending = poll(entry).then(
      () => undefined,
      (error: unknown) => error,
    )
    return { pending, entry }
  })
  try {
    await entered.promise
    await runtime.run(() => AgendaGithubTrigger.stop())
    await runtime.close()
    response.resolve(Response.json(pull))
    expect(await pending).toBeUndefined()
    expect(signals).toEqual([])
    expect(entry.timer).toBeUndefined()
    await survivor.run(() => expect(AgendaGithubTrigger.active()).toEqual({ items: 1, entries: 1 }))
  } finally {
    response.resolve(Response.json(pull))
    await pending
    await survivor.run(() => AgendaGithubTrigger.stop())
  }
})

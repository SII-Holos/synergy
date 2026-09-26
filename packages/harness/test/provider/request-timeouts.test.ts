import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { afterEach, expect, spyOn, test } from "bun:test"
import type { Provider as SDK } from "ai"
import { Config } from "../../src/config/config"
import { Provider as ProviderConfig } from "../../src/config/schema"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { Provider } from "../../src/provider/provider"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { ScopeContext } from "../../src/scope/context"
import { TimeoutConfig } from "../../src/util/timeout-config"
import { Scope } from "../../src/scope"
import { LLM } from "../../src/session/llm"

afterEach(runtime.bind(() => TimeoutConfig.invalidate()))

test(
  "the documented global wall_sec zero disables the wall watchdog",
  runtime.bind(async () => {
    const config = Config.Info.parse({ timeout: { provider: { wall_sec: 0 } } })
    using current = spyOn(Config, "current").mockResolvedValue(config)
    TimeoutConfig.invalidate()
    expect((await TimeoutConfig.resolve()).providerWallMs).toBe(0)
  }),
)

test(
  "provider wall_sec zero overrides a positive global wall budget",
  runtime.bind(async () => {
    const config = Config.Info.parse({
      timeout: { provider: { wall_sec: 1 } },
      provider: { review: { timeout: { wall_sec: 0 } } },
    })
    expect(ProviderConfig.safeParse({ timeout: { wall_sec: false } }).success).toBe(false)
    using current = spyOn(Config, "current").mockResolvedValue(config)
    TimeoutConfig.invalidate()
    expect((await TimeoutConfig.forProvider({ providerID: "review" })).providerWallMs).toBe(0)
  }),
)

function model(providerID: string, id: string, options: Record<string, unknown> = {}): Provider.Model {
  return {
    id,
    providerID,
    name: id,
    api: { id, url: "https://review.invalid/v1", npm: "review-sdk" },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options,
    headers: {},
    release_date: "2026-01-01",
  }
}

async function withWorker(fn: (fetches: Array<ReturnType<typeof Provider.createTimeoutFetch>>) => Promise<void>) {
  const fetches: Array<ReturnType<typeof Provider.createTimeoutFetch>> = []
  const factory: ProviderSdkSource.Factory = (options) => {
    fetches.push(options.fetch as ReturnType<typeof Provider.createTimeoutFetch>)
    return {
      languageModel(id: string) {
        return { modelId: id }
      },
    } as unknown as SDK
  }
  await using worker = await testRuntime({
    env: { SYNERGY_AGENT_WORKER: "1" },
    register: () => ProviderSdkSource.register({ load: async () => factory, loadSync: () => factory }),
  })
  await worker.run(() => ScopeContext.provide({ scope: Scope.home(), fn: () => fn(fetches) }))
}

test(
  "worker plans preserve model-level legacy idle overrides",
  runtime.bind(async () => {
    const spec = model("review-legacy", "reasoning", { timeout: false })
    using current = spyOn(Config, "current").mockResolvedValue(
      Config.Info.parse({
        timeout: { provider: { wall_sec: 0 } },
        provider: {
          "review-legacy": {
            npm: "review-sdk",
            options: { timeout: 20, apiKey: "fixture" },
            models: { reasoning: {} },
          },
        },
      }),
    )
    const prepared = await ScopeContext.provide({
      scope: Scope.home(),
      fn: () =>
        LLM.prepare({
          sessionID: "test-session",
          user: { id: "test-message" },
          agent: { name: "synergy", prompt: "Reply briefly.", options: {} },
          model: spec,
          system: [],
          messages: [],
          tools: {},
          abort: new AbortController().signal,
        } as unknown as LLM.StreamInput),
    })
    expect(prepared.provider.timeouts.idleMs).toBe(false)
    await withWorker(async (fetches) => {
      await Provider.configureWorkerProvider(spec, prepared.provider)
      await Provider.getSDK(spec, {
        ...spec.options,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("first"))
                await Bun.sleep(80)
                try {
                  controller.enqueue(new TextEncoder().encode("second"))
                  controller.close()
                } catch {}
              },
            }),
          ),
      })
      const response = await fetches[0]("https://review.invalid/v1", {})
      await expect(response.text()).resolves.toBe("firstsecond")
    })
  }),
)

test(
  "a reused SDK labels fetch metrics with the requested model",
  runtime.bind(async () => {
    await withWorker(async (fetches) => {
      using rows = spyOn(ObservabilityMetrics, "record")
      const options = { fetch: async () => new Response("ok") }
      const plan = { options: {}, timeouts: { ttfbMs: 5000, idleMs: false as const, wallMs: 0 } }
      const first = model("review-labels", "first-model")
      const second = model("review-labels", "second-model")
      await Provider.configureWorkerProvider(first, plan)
      await Provider.getSDK(first, options)
      await (await fetches[0]("https://review.invalid/v1", {})).text()
      await Provider.configureWorkerProvider(second, plan)
      await Provider.getSDK(second, options)
      await (await fetches.at(-1)!("https://review.invalid/v1", {})).text()
      expect(
        rows.mock.calls.filter(([row]) => row.name === "llm.fetch.headers").map(([row]) => row.labels?.model),
      ).toEqual(["first-model", "second-model"])
    })
  }),
)

test(
  "completed requests release their transport objects while wall timeout is pending",
  runtime.bind(async () => {
    const refs: WeakRef<Request>[] = []
    const timeoutFetch = Provider.createTimeoutFetch({
      fetchFn: async (input) => {
        if (input instanceof Request) refs.push(new WeakRef(input))
        return new Response("ok")
      },
      noProxy: false,
      timeouts: { providerTtfbMs: 5000, providerIdleMs: false, providerWallMs: 1800000 },
      labels: { provider: "review", model: "review" },
    })
    for (let i = 0; i < 16; i++)
      await (await timeoutFetch(new Request("https://review.invalid/v1", { method: "POST", body: "prompt" }))).text()
    expect(refs).toHaveLength(16)
    await Bun.sleep(0)
    Bun.gc(true)
    await Bun.sleep(0)
    Bun.gc(true)
    expect(refs.filter((ref) => ref.deref()).length).toBeLessThan(4)
  }),
)

afterRuntimeTests(() => runtime.close())

test(
  "a reused language model observes the current worker timeout plan",
  runtime.bind(async () => {
    await withWorker(async (fetches) => {
      const spec = model("review-cache", "same-model")
      const options = {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("first"))
                await Bun.sleep(80)
                try {
                  controller.enqueue(new TextEncoder().encode("second"))
                  controller.close()
                } catch {}
              },
            }),
          ),
      }
      await Provider.configureWorkerProvider(spec, { options, timeouts: { ttfbMs: 5000, idleMs: 20, wallMs: 0 } })
      await Provider.getLanguage(spec)
      await expect((await fetches.at(-1)!("https://review.invalid/v1", {})).text()).rejects.toThrow("Idle timeout")
      await Provider.configureWorkerProvider(spec, { options, timeouts: { ttfbMs: 5000, idleMs: false, wallMs: 0 } })
      const language = await Provider.getLanguage(spec)
      await expect((await fetches.at(-1)!("https://review.invalid/v1", {})).text()).resolves.toBe("firstsecond")
      expect(await Provider.getLanguage(spec)).toBe(language)
    })
  }),
)

test("effective timeout policies stay independent across Runtime instances", async () => {
  const config = (idle: number) =>
    JSON.stringify({
      timeout: { provider: { idle_sec: idle } },
      provider: { isolated: { npm: "review-sdk", options: { apiKey: "fixture" }, models: { test: {} } } },
    })
  await using first = await testRuntime({ env: { SYNERGY_CONFIG_CONTENT: config(1) } })
  await using second = await testRuntime({ env: { SYNERGY_CONFIG_CONTENT: config(2) } })
  const resolve = (owner: typeof first) =>
    owner.run(() =>
      ScopeContext.provide({ scope: Scope.home(), fn: () => Provider.requestTimeouts(model("isolated", "test")) }),
    )
  expect((await resolve(first)).providerIdleMs).toBe(1000)
  expect((await resolve(second)).providerIdleMs).toBe(2000)
  await first.close()
  expect((await resolve(second)).providerIdleMs).toBe(2000)
})

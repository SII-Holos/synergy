import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ModelsCatalog } from "../../src/provider/models"
import { ProviderCatalog } from "../../src/provider/catalog"
import { RuntimeReloadExecutor } from "../../src/config/reload-executor"

test("closing a Runtime aborts a pending catalog request and prevents a mirror retry", async () => {
  let requestSignal: AbortSignal | undefined
  let requests = 0
  using fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests++
        requestSignal = init?.signal ?? undefined
        await new Promise<void>((resolve) => requestSignal?.addEventListener("abort", () => resolve(), { once: true }))
        throw requestSignal?.reason
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const runtime = await testRuntime({ env: { SYNERGY_DISABLE_MODELS_FETCH: "false" } })
  const pending = runtime.run(() => ModelsCatalog.refresh())
  await runtime.close()
  expect(requestSignal?.aborted).toBe(true)
  expect(await pending).toEqual({ status: "failed" })
  expect(requests).toBe(1)
})

test("provider shutdown drains a catalog reload already in progress and ignores later refreshes", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    let listener: () => void | Promise<void> = () => {}
    using subscription = spyOn(ModelsCatalog, "onRefresh").mockImplementation((callback) => {
      listener = callback
      return () => true
    })
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const result = await RuntimeReloadExecutor.reloadGlobal({ targets: ["provider"] })
    using reload = spyOn(RuntimeReloadExecutor, "reloadGlobal").mockImplementation(async () => {
      started()
      await held
      return result
    })
    const unsubscribe = await ProviderCatalog.subscribeModelCatalog()
    const refresh = listener()
    await entered
    let closed = false
    const closing = ProviderCatalog.stop().then(() => {
      closed = true
    })
    try {
      await Bun.sleep(5)
      expect(closed).toBe(false)
    } finally {
      release()
      await Promise.all([refresh, closing])
    }
    await listener()
    expect(reload).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

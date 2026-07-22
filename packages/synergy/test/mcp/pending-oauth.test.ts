import { afterEach, describe, expect, mock, test } from "bun:test"
import { PendingOAuth } from "../../src/mcp/pending-oauth"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function connection() {
  const close = mock(async () => {})
  const finishAuth = mock(async (_authorizationCode: string) => {})
  return {
    close,
    finishAuth,
    value: {
      client: { close },
      transport: { finishAuth },
      identity: crypto.randomUUID(),
    },
  }
}

afterEach(async () => {
  await PendingOAuth.disposeAll("test cleanup")
})

describe.serial("PendingOAuth", () => {
  test("replacing a pending connection closes the previous owner", async () => {
    const first = connection()
    const second = connection()

    await PendingOAuth.register("demo", first.value)
    await PendingOAuth.register("demo", second.value)

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(PendingOAuth.get("demo")?.transport).toBe(second.value.transport)
  })

  test("serializes concurrent replacements so the last registration wins", async () => {
    let releaseInitial!: () => void
    const initialReleased = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    const initial = connection()
    initial.value.client.close = mock(async () => initialReleased)
    const first = connection()
    const second = connection()
    await PendingOAuth.register("demo", initial.value)

    const firstRegistration = PendingOAuth.register("demo", first.value)
    await Promise.resolve()
    const secondRegistration = PendingOAuth.register("demo", second.value)
    releaseInitial()
    await Promise.all([firstRegistration, secondRegistration])

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(PendingOAuth.get("demo")?.transport).toBe(second.value.transport)
  })

  test("dispose closes a pending connection exactly once", async () => {
    const pending = connection()
    await PendingOAuth.register("demo", pending.value)

    await PendingOAuth.dispose("demo", "cancelled")
    await PendingOAuth.dispose("demo", "cancelled again")

    expect(pending.close).toHaveBeenCalledTimes(1)
    expect(PendingOAuth.get("demo")).toBeUndefined()
  })

  test("disposeIfCurrent preserves a replacement owner", async () => {
    const first = connection()
    const second = connection()
    await PendingOAuth.register("demo", first.value)
    const firstOwner = PendingOAuth.get("demo")!
    await PendingOAuth.register("demo", second.value)

    const disposed = await PendingOAuth.disposeIfCurrent("demo", firstOwner, "stale interaction ended")

    expect(disposed).toBe(false)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(PendingOAuth.get("demo")?.transport).toBe(second.value.transport)
  })

  test("expired pending connections close their owner", async () => {
    const pending = connection()
    await PendingOAuth.register("demo", pending.value, { timeoutMs: 5 })

    await Bun.sleep(25)

    expect(pending.close).toHaveBeenCalledTimes(1)
    expect(PendingOAuth.get("demo")).toBeUndefined()
  })
})

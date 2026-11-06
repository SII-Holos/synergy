import { describe, expect, jest, mock, spyOn, test } from "bun:test"
import path from "node:path"
import nodemailer, { type SendMailOptions, type Transport } from "nodemailer"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Email } from "../../src/email/service"
import { testRuntime } from "../support/runtime"

const account = {
  from: { address: "sender@example.test", name: "Fixture Sender" },
  smtp: { host: "smtp.example.test", port: 587, secure: false, username: "sender", password: "fixture-secret" },
}
const message = { to: "recipient@example.test", subject: "Fixture subject", text: "Fixture body" }

function smtpFixture() {
  const createTransport = nodemailer.createTransport
  const factoryTarget: {
    createTransport: (...args: Parameters<typeof createTransport>) => ReturnType<typeof createTransport>
  } = nodemailer
  const pools: Array<{
    messages: SendMailOptions[]
    close: ReturnType<typeof mock<() => void>>
    failure?: Error
    disconnect(): void
  }> = []
  const factory = spyOn(factoryTarget, "createTransport").mockImplementation(() => {
    const messages: SendMailOptions[] = []
    const close = mock(() => {})
    const pool = {
      messages,
      close,
      failure: undefined as Error | undefined,
      disconnect: () => {},
    }
    const id = pools.push(pool)
    const driver: Transport<{ messageId: string }> = {
      name: "fixture",
      version: "1",
      close,
      send(mail, callback) {
        messages.push(mail.data)
        callback(pool.failure ?? null, { messageId: `fixture-${id}-${messages.length}` })
      },
    }
    const transporter = createTransport(driver)
    const disconnect = RuntimeContext.current().bind(() => transporter.emit("error", new Error("Fixture disconnected")))
    pool.disconnect = () => {
      if (close.mock.calls.length === 0) disconnect()
    }
    return transporter
  })
  return {
    factory,
    pools,
    disconnect() {
      for (const pool of pools) pool.disconnect()
    },
    [Symbol.dispose]() {
      factory.mockRestore()
    },
  }
}

describe("transportIdentityKey", () => {
  test("excludes the password from the cache key", () => {
    const key = Email.transportIdentityKey({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "agent@example.com",
      password: "super-secret-token",
    })
    expect(key).not.toContain("super-secret-token")
    expect(key).toContain("smtp.example.com")
    expect(key).toContain("passwordFingerprint")
  })

  test("password rotation yields a different key so the pooled transport is rebuilt", () => {
    const base = {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "agent@example.com",
    }
    const keyA = Email.transportIdentityKey({ ...base, password: "secret-a" })
    const keyB = Email.transportIdentityKey({ ...base, password: "secret-b" })
    expect(keyA).not.toBe(keyB)
  })

  test("different identity fields produce different keys", () => {
    const base = {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: "agent@example.com",
      password: "secret",
    }
    const other = Email.transportIdentityKey({ ...base, host: "smtp.other.com" })
    expect(other).not.toBe(Email.transportIdentityKey(base))
  })
})

describe("SMTP service", () => {
  for (const scenario of [
    { name: "absent", config: {}, error: Email.NotConfiguredError, missing: ["email"] },
    { name: "disabled", config: { email: { enabled: false } }, error: Email.DisabledError },
    {
      name: "incomplete",
      config: { email: { enabled: true } },
      error: Email.NotConfiguredError,
      missing: [
        "email.from.address",
        "email.smtp.host",
        "email.smtp.port",
        "email.smtp.secure",
        "email.smtp.username",
        "email.smtp.password",
      ],
    },
  ]) {
    test(`${scenario.name} configuration fails before opening a transport`, async () => {
      await using runtime = await testRuntime()
      using smtp = smtpFixture()
      await runtime.run(async () => {
        await using tmp = await tmpdir({ config: scenario.config })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          async fn() {
            const error = await Email.send(message).catch((error: unknown) => error)
            expect(scenario.error.isInstance(error)).toBe(true)
            expect(Email.SendFailedError.isInstance(error)).toBe(false)
            if (scenario.missing) {
              expect(Email.NotConfiguredError.isInstance(error)).toBe(true)
              if (Email.NotConfiguredError.isInstance(error)) expect(error.data.missing).toEqual(scenario.missing)
            }
            expect(smtp.factory).not.toHaveBeenCalled()
          },
        })
      })
    })
  }

  test("sends complete mail and reuses the connection until credentials change", async () => {
    await using runtime = await testRuntime()
    using smtp = smtpFixture()
    try {
      await runtime.run(async () => {
        await using tmp = await tmpdir({ config: { email: account } })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          async fn() {
            const attachments = [{ filename: "report.txt", content: Buffer.from("report"), contentType: "text/plain" }]
            expect(
              await Email.send({
                ...message,
                to: ["one@example.test", "two@example.test"],
                html: "<p>Body</p>",
                attachments,
              }),
            ).toEqual({ messageId: "fixture-1-1" })
            expect(smtp.factory).toHaveBeenCalledWith({
              host: account.smtp.host,
              port: account.smtp.port,
              secure: false,
              auth: { user: account.smtp.username, pass: account.smtp.password },
              pool: true,
              maxConnections: 2,
              maxMessages: 50,
            })
            expect(smtp.pools[0].messages[0]).toMatchObject({
              from: "Fixture Sender <sender@example.test>",
              to: "one@example.test, two@example.test",
              subject: message.subject,
              text: message.text,
              html: "<p>Body</p>",
              attachments,
            })
            const root = path.join(tmp.path, ".synergy")
            await Config.domainUpdate("email", { email: { from: { address: "new@example.test", name: "" } } }, { root })
            expect(await Email.send(message)).toEqual({ messageId: "fixture-1-2" })
            expect(smtp.factory).toHaveBeenCalledTimes(1)
            expect(smtp.pools[0].messages[1].from).toBe("new@example.test")
            expect(smtp.pools[0].messages[1].html).toBeUndefined()
            expect(smtp.pools[0].messages[1].attachments).toBeUndefined()
            await Config.domainUpdate("email", { email: { smtp: { password: "rotated-secret" } } }, { root })
            expect(await Email.send(message)).toEqual({ messageId: "fixture-2-1" })
            expect(smtp.factory).toHaveBeenCalledTimes(2)
            expect(smtp.pools[0].close).toHaveBeenCalledTimes(1)
            expect(smtp.factory.mock.calls[1][0]).toMatchObject({ auth: { user: "sender", pass: "rotated-secret" } })
          },
        })
      })
    } finally {
      smtp.disconnect()
    }
  })

  test("SMTP rejection retains structured diagnostics and discards the failed connection", async () => {
    await using runtime = await testRuntime()
    using smtp = smtpFixture()
    try {
      await runtime.run(async () => {
        await using tmp = await tmpdir({ config: { email: account } })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          async fn() {
            await Email.send(message)
            smtp.pools[0].failure = Object.assign(new Error("Unknown recipient"), {
              code: "EENVELOPE",
              response: "550 Unknown recipient",
              command: "RCPT TO",
            })
            const error = await Email.send(message).catch((error: unknown) => error)
            expect(Email.SendFailedError.isInstance(error)).toBe(true)
            if (Email.SendFailedError.isInstance(error))
              expect(error.data).toEqual({
                message: "Failed to send email: Unknown recipient",
                code: "EENVELOPE",
                response: "550 Unknown recipient",
                command: "RCPT TO",
              })
            expect(smtp.pools[0].close).toHaveBeenCalledTimes(1)
            expect(await Email.send(message)).toEqual({ messageId: "fixture-2-1" })
            smtp.pools[1].disconnect()
            expect(smtp.pools[1].close).toHaveBeenCalledTimes(1)
            expect(await Email.send(message)).toEqual({ messageId: "fixture-3-1" })
          },
        })
      })
    } finally {
      smtp.disconnect()
    }
  })

  test("each successful send renews the idle deadline and the expired pool reconnects", async () => {
    await using runtime = await testRuntime()
    using smtp = smtpFixture()
    await runtime.run(async () => {
      await using tmp = await tmpdir({ config: { email: account } })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          await Config.current()
          jest.useFakeTimers()
          try {
            await Email.send(message)
            jest.advanceTimersByTime(30_000)
            await Email.send(message)
            jest.advanceTimersByTime(59_999)
            expect(smtp.pools[0].close).not.toHaveBeenCalled()
            jest.advanceTimersByTime(1)
            expect(smtp.pools[0].close).toHaveBeenCalledTimes(1)
            Email.close()
            Email.close()
            expect(smtp.pools[0].close).toHaveBeenCalledTimes(1)
            expect(await Email.send(message)).toEqual({ messageId: "fixture-2-1" })
          } finally {
            smtp.disconnect()
            jest.useRealTimers()
          }
        },
      })
    })
  })

  test("interleaved Runtimes keep separate pools and disconnect independently", async () => {
    await using left = await testRuntime()
    await using right = await testRuntime()
    using smtp = smtpFixture()
    await using leftDirectory = await left.run(() => tmpdir({ config: { email: account } }))
    await using rightDirectory = await right.run(() => tmpdir({ config: { email: account } }))
    const send = (runtime: typeof left, directory: typeof leftDirectory) =>
      runtime.run(async () => ScopeContext.provide({ scope: await directory.scope(), fn: () => Email.send(message) }))
    try {
      expect(await send(left, leftDirectory)).toEqual({ messageId: "fixture-1-1" })
      expect(await send(right, rightDirectory)).toEqual({ messageId: "fixture-2-1" })
      expect(await send(left, leftDirectory)).toEqual({ messageId: "fixture-1-2" })
      expect(smtp.factory).toHaveBeenCalledTimes(2)
      smtp.pools[0].disconnect()
      expect(smtp.pools[0].close).toHaveBeenCalledTimes(1)
      expect(smtp.pools[1].close).not.toHaveBeenCalled()
      expect(await send(right, rightDirectory)).toEqual({ messageId: "fixture-2-2" })
      expect(await send(left, leftDirectory)).toEqual({ messageId: "fixture-3-1" })
      await left.close()
      expect(smtp.pools[2].close).toHaveBeenCalledTimes(1)
      expect(smtp.pools[1].close).not.toHaveBeenCalled()
      expect(await send(right, rightDirectory)).toEqual({ messageId: "fixture-2-3" })
    } finally {
      smtp.disconnect()
    }
  })

  test("closing a Runtime closes its SMTP pool before the idle deadline", async () => {
    await using runtime = await testRuntime()
    using smtp = smtpFixture()
    await runtime.run(async () => {
      await using tmp = await tmpdir({ config: { email: account } })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          await Config.current()
          jest.useFakeTimers()
          try {
            await Email.send(message)
            await runtime.close()
            expect(smtp.pools[0].close).toHaveBeenCalledTimes(1)
            await runtime.close()
            expect(() => jest.advanceTimersByTime(60_000)).not.toThrow()
            expect(smtp.pools[0].close).toHaveBeenCalledTimes(1)
          } finally {
            jest.clearAllTimers()
            jest.useRealTimers()
          }
        },
      })
    })
  })
})

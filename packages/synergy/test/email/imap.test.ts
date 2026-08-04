import { describe, expect, test } from "bun:test"
import { EmailImap } from "../../src/email/imap"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("parseMessage", () => {
  test("decodes quoted-printable bodies (regression: raw transfer-encoding leaked)", async () => {
    const source = [
      "From: sender@example.com",
      "To: recv@example.com",
      "Subject: Decode test",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello =E4=B8=96=E7=95=8C, this =",
      "wraps.",
      "",
    ].join("\r\n")

    const parsed = await EmailImap.parseMessage(source)
    expect(parsed.text).toContain("Hello 世界")
    expect(parsed.text).toContain("wraps")
    // No raw transfer-encoding artifacts must remain.
    expect(parsed.text).not.toContain("=E4")
    expect(parsed.text).not.toContain("=")
    expect(parsed.attachments).toEqual([])
  })

  test("parses base64 body and decodes it", async () => {
    const source = [
      "From: sender@example.com",
      "To: recv@example.com",
      "Subject: Test",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      "SGVsbG8g5LiW55WM",
      "",
    ].join("\r\n")

    const parsed = await EmailImap.parseMessage(source)
    expect(parsed.text).toContain("Hello 世界")
  })

  test("extracts attachment metadata without content", async () => {
    const source = [
      "From: sender@example.com",
      "To: recv@example.com",
      "Subject: With attachment",
      'Content-Type: multipart/mixed; boundary="boundary42"',
      "",
      "--boundary42",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body text here",
      "",
      "--boundary42",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "",
      "--boundary42--",
      "",
    ].join("\r\n")

    const parsed = await EmailImap.parseMessage(source)
    expect(parsed.text).toContain("Body text here")
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]).toMatchObject({
      filename: "report.pdf",
      contentType: "application/pdf",
    })
    expect(parsed.attachments[0].size).toBeGreaterThan(0)
  })

  test("html-only messages produce text via mailparser", async () => {
    const source = [
      "From: sender@example.com",
      "To: recv@example.com",
      "Subject: HTML only",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<html><body><p>Hello <b>HTML</b> world</p></body></html>",
      "",
    ].join("\r\n")

    const parsed = await EmailImap.parseMessage(source)
    expect(parsed.text).toBeDefined()
    expect(parsed.text).toContain("Hello")
    expect(parsed.html).toContain("<html>")
  })
})

describe("config error propagation", () => {
  test("no email config surfaces NotConfiguredError, not FetchFailedError", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const error = await EmailImap.search("INBOX", { all: true }).catch((e: unknown) => e)
        expect(EmailImap.NotConfiguredError.isInstance(error)).toBe(true)
        expect(EmailImap.FetchFailedError.isInstance(error)).toBe(false)
        expect((error as { data: { missing?: string[] } }).data.missing).toContain("email")
      },
    })
  })

  test("incomplete IMAP config reports the missing fields", async () => {
    await using tmp = await tmpdir({
      config: { email: { enabled: true } },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const error = await EmailImap.search("INBOX", { all: true }).catch((e: unknown) => e)
        expect(EmailImap.NotConfiguredError.isInstance(error)).toBe(true)
        expect(EmailImap.FetchFailedError.isInstance(error)).toBe(false)
        const missing = (error as { data: { missing?: string[] } }).data.missing ?? []
        expect(missing).toEqual(
          expect.arrayContaining([
            "email.imap.host",
            "email.imap.port",
            "email.imap.secure",
            "email.imap.username",
            "email.imap.password",
          ]),
        )
      },
    })
  })

  test("disabled email surfaces DisabledError", async () => {
    await using tmp = await tmpdir({
      config: { email: { enabled: false } },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const error = await EmailImap.search("INBOX", { all: true }).catch((e: unknown) => e)
        expect(EmailImap.DisabledError.isInstance(error)).toBe(true)
        expect(EmailImap.FetchFailedError.isInstance(error)).toBe(false)
      },
    })
  })
})

describe("config resolution sanity", () => {
  test("email section absent in default-resolved config without fragment", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const config = await Config.current()
        expect(config.email).toBeUndefined()
      },
    })
  })
})

describe("isTruncated", () => {
  test("server-reported size over the cap flags truncation", () => {
    expect(EmailImap.isTruncated(EmailImap.EMAIL_MAX_BYTES + 1, 100)).toBe(true)
    expect(EmailImap.isTruncated(EmailImap.EMAIL_MAX_BYTES, 100)).toBe(false)
  })

  test("falls back to received bytes when the server reports no size", () => {
    expect(EmailImap.isTruncated(undefined, EmailImap.EMAIL_MAX_BYTES)).toBe(true)
    expect(EmailImap.isTruncated(undefined, EmailImap.EMAIL_MAX_BYTES - 1)).toBe(false)
  })
})

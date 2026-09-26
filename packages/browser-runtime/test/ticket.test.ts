import { afterEach, describe, expect, test } from "bun:test"
import type { BrowserOwner } from "../src/owner"
import { BrowserTicket } from "../src/ticket"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

const owner: BrowserOwner.Info = {
  mode: "session",
  scopeID: "ticket-scope",
  sessionID: "ticket-session",
  directory: process.cwd(),
}

afterEach(() => runtime.run(() => BrowserTicket.resetForTest()))

describe("BrowserTicket", () => {
  test("is single-use and bound to owner, page, and role", () =>
    runtime.run(() => {
      const viewer = BrowserTicket.issue(owner, "page-1", "viewer")
      BrowserTicket.consume(owner, "page-1", "viewer", viewer.ticket)
      expect(() => BrowserTicket.consume(owner, "page-1", "viewer", viewer.ticket)).toThrow()

      const host = BrowserTicket.issue(owner, "page-1", "host")
      expect(() => BrowserTicket.consume(owner, "page-1", "viewer", host.ticket)).toThrow()

      const wrongPage = BrowserTicket.issue(owner, "page-1", "viewer")
      expect(() => BrowserTicket.consume(owner, "page-2", "viewer", wrongPage.ticket)).toThrow()

      const wrongOwner = BrowserTicket.issue(owner, "page-1", "viewer")
      expect(() =>
        BrowserTicket.consume({ ...owner, sessionID: "other-session" }, "page-1", "viewer", wrongOwner.ticket),
      ).toThrow()
    }))

  test("revokes outstanding tickets for a closed page", () =>
    runtime.run(() => {
      const issued = BrowserTicket.issue(owner, "page-1", "viewer")
      BrowserTicket.revoke(owner, "page-1")
      expect(() => BrowserTicket.consume(owner, "page-1", "viewer", issued.ticket)).toThrow()
    }))
})

afterRuntimeTests(() => runtime.close())

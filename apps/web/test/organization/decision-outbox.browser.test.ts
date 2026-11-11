import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

declare global {
  interface Window {
    decisionOutboxFixture: typeof import("../../src/organization/decision-outbox")
    decisionRuntimeFixture: typeof import("../../src/organization/interaction-runtime") & {
      createOrganizationConnections: (typeof import("../../src/organization/connections"))["createOrganizationConnections"]
      createOrganizationClient: (typeof import("@ericsanchezok/synergy-sdk/organization"))["createOrganizationClient"]
      createRoot: (typeof import("solid-js"))["createRoot"]
    }
  }
}
let browser: Browser
let fixture: BrowserFixture
let directory: string
beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(import.meta.dir, "../../node_modules/.decision-outbox-"))
  await Bun.write(path.join(directory, "index.html"), '<script type="module" src="/main.ts"></script>')
  await Bun.write(
    path.join(directory, "main.ts"),
    `import * as outbox from ${JSON.stringify(`/@fs/${path.resolve(import.meta.dir, "../../src/organization/decision-outbox.ts")}`)};import {createOrganizationInteractionRuntime} from ${JSON.stringify(`/@fs/${path.resolve(import.meta.dir, "../../src/organization/interaction-runtime.ts")}`)};import {createOrganizationConnections} from ${JSON.stringify(`/@fs/${path.resolve(import.meta.dir, "../../src/organization/connections.ts")}`)};import {createOrganizationClient} from "@ericsanchezok/synergy-sdk/organization";import {createRoot} from "solid-js";window.decisionOutboxFixture=outbox;window.decisionRuntimeFixture={createOrganizationInteractionRuntime,createOrganizationClient,createRoot,createOrganizationConnections};Date.now=()=>1;`,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: false,
    localized: false,
    aliases: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../src") }],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

test("the real IndexedDB outbox pages beyond 128 unresolved responses without reading command payloads", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.decisionOutboxFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationDecisionOutbox, removeOrganizationDecisionOutbox } = window.decisionOutboxFixture
      const owner = {
        connectionKey: "connection-one",
        accountID: "account-one",
        projectID: "project-one",
        rootSessionID: "session-one",
        sourceSessionID: "session-one",
      }
      const binding = {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        creatorID: "account-one",
        driverRuntimeID: "runtime-one",
        bindingEpoch: 1,
      } as const
      const store = createOrganizationDecisionOutbox({ owner, binding })
      try {
        for (let index = 0; index < 160; index++) {
          const id = String(index).padStart(3, "0")
          await store.begin(
            {
              schemaVersion: 1,
              orgID: "org-one",
              requestID: `logical-${id}`,
              sessionID: "session-one",
              projectID: "project-one",
              runtimeID: "runtime-one",
              decision: {
                operation: "decision",
                kind: "question",
                requestID: `native-${id}`,
                reply: "answer",
                answers: [[`ordinary-${id}`]],
              },
            },
            false,
          )
        }
        let cursor: string | undefined
        const ids: string[] = []
        let pages = 0
        const original = IDBObjectStore.prototype.get
        let payloadReads = 0
        IDBObjectStore.prototype.get = function (query) {
          if (this.name === "payloads") payloadReads++
          return original.call(this, query)
        }
        try {
          do {
            const result = await store.page({ limit: 23, cursor })
            ids.push(...result.items.map((item) => item.requestID))
            cursor = result.cursor
            pages++
          } while (cursor)
        } finally {
          IDBObjectStore.prototype.get = original
        }
        const record = await store.native("question", "native-159")
        const command = record ? await store.command(record) : undefined
        await removeOrganizationDecisionOutbox(owner.connectionKey)
        return {
          ids,
          pages,
          payloadReads,
          answer: command?.decision.kind === "question" ? command.decision.answers?.[0]?.[0] : undefined,
          remaining: (await store.page()).items.length,
        }
      } finally {
        store.dispose()
      }
    })
    expect(result.ids).toHaveLength(160)
    expect(new Set(result.ids).size).toBe(160)
    expect(result.ids[159]).toBe("logical-159")
    expect(result.pages).toBe(7)
    expect(result.payloadReads).toBe(0)
    expect(result.answer).toBe("ordinary-159")
    expect(result.remaining).toBe(0)
  } finally {
    await page.close()
  }
}, 30_000)
test("sensitive originals remain in one live owner and disposal cannot repopulate them from stored metadata", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.decisionOutboxFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationDecisionOutbox } = window.decisionOutboxFixture
      const owner = {
        connectionKey: "connection-one",
        accountID: "account-one",
        projectID: "project-one",
        rootSessionID: "session-one",
        sourceSessionID: "session-one",
      }
      const binding = {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        creatorID: "account-one",
        driverRuntimeID: "runtime-one",
        bindingEpoch: 1,
      } as const
      const command = {
        schemaVersion: 1,
        orgID: "org-one",
        requestID: "logical-sensitive",
        sessionID: "session-one",
        projectID: "project-one",
        runtimeID: "runtime-one",
        decision: {
          operation: "decision",
          kind: "question",
          requestID: "native-sensitive",
          reply: "answer",
          answers: [["private-original"]],
        },
      } as const
      const input = {
        ...command,
        decision: { ...command.decision, answers: command.decision.answers.map((answer) => [...answer]) },
      }
      const first = createOrganizationDecisionOutbox({ owner, binding })
      const second = createOrganizationDecisionOutbox({ owner, binding })
      const foreign = createOrganizationDecisionOutbox({ owner: { ...owner, accountID: "another-account" }, binding })
      try {
        const record = await first.begin(input, true)
        const readable = await first.command(record)
        await second.begin(input, true)
        const other = await second.command(record)
        const page = await first.page()
        let conflict = false
        try {
          await second.begin({ ...input, requestID: "different-logical" }, true)
        } catch {
          conflict = true
        }
        const foreignRow = await foreign.native("question", "native-sensitive")
        first.dispose()
        const restored = await second.native("question", "native-sensitive")
        const original = restored ? await second.command(restored) : undefined
        if (restored) await second.remove(restored)
        return {
          readable: readable?.decision.kind === "question" ? readable.decision.answers?.[0]?.[0] : undefined,
          other: other !== undefined,
          original: original !== undefined,
          conflict,
          foreign: foreignRow !== undefined,
          page: JSON.stringify(page),
          remaining: (await second.page()).items.length,
        }
      } finally {
        first.dispose()
        second.dispose()
        foreign.dispose()
      }
    })
    expect(result.readable).toBe("private-original")
    expect(result.other).toBe(false)
    expect(result.original).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.foreign).toBe(false)
    expect(result.page).not.toContain("private-original")
    expect(result.remaining).toBe(0)
  } finally {
    await page.close()
  }
})

test("finite pages do not confirm a lost password reply and a native winner does not erase its logical receipt", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.decisionRuntimeFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationInteractionRuntime, createOrganizationClient, createRoot } =
        window.decisionRuntimeFixture
      const binding = {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        creatorID: "account-one",
        driverRuntimeID: "runtime-one",
        bindingEpoch: 1,
      } as const
      const native = {
        kind: "question",
        requestID: "native-one",
        sourceSessionID: "session-one",
        questions: [{ header: "Password", question: "Enter a password", options: [], input_type: "password" }],
      } as const
      let phase: "pending" | "missing-page" | "resolved" = "pending"
      let submitted = 0
      let denied = false
      let lookup: "unknown" | "not_dispatched" = "unknown"
      const api = createOrganizationClient({
        baseUrl: "https://organization.example",
        fetch: Object.assign(
          async (input: RequestInfo | URL) => {
            const request = new Request(input)
            const url = new URL(request.url)
            if (denied) return Response.json({ code: "permission_denied" }, { status: 403 })
            if (url.pathname.endsWith("/interactions/reply")) {
              submitted++
              return Response.json({ code: "COMMAND_OUTCOME_UNKNOWN" }, { status: 504 })
            }
            if (url.pathname.includes("/commands/"))
              return Response.json({
                requestID: url.pathname.split("/").at(-1),
                attemptID: "attempt",
                state: lookup,
                authorizedAt: 1,
              })
            const query = await request.json()
            const envelope = {
              rootSessionID: "session-one",
              sourceSessionID: "session-one",
              binding,
              runtimeKind: "hosted",
            }
            if (query.operation === "pending")
              return Response.json({
                ...envelope,
                operation: "pending",
                items: phase === "pending" ? [native] : [],
                hasMore: false,
              })
            return Response.json({
              ...envelope,
              operation: "decisions",
              items: [
                phase === "resolved"
                  ? {
                      identity: { kind: "question", requestID: native.requestID },
                      state: "resolved",
                      winner: {
                        sessionID: "session-one",
                        requestID: native.requestID,
                        decidedAt: 2,
                        actor: {
                          kind: "account",
                          subjectID: "another-account",
                          displayName: "Another member",
                          clientKind: "web",
                          requestID: "another-logical",
                          orgID: "org-one",
                        },
                        outcome: { kind: "question", reply: "answer" },
                      },
                    }
                  : { identity: { kind: "question", requestID: native.requestID }, state: "pending" },
              ],
            })
          },
          { preconnect() {} },
        ),
      })
      const mount = () =>
        createRoot((dispose) => ({
          dispose,
          runtime: createOrganizationInteractionRuntime({
            api,
            accountID: "account-one",
            connectionKey: "runtime-sensitive",
            rootSessionID: "session-one",
            binding,
            signal: new AbortController().signal,
          }),
        }))
      const current = mount()
      let first
      try {
        await current.runtime.load()
        const question = {
          id: native.requestID,
          sessionID: "session-one",
          questions: native.questions.map((item) => ({ ...item, options: [] })),
        }
        await current.runtime.decisions.respondQuestion(question, [["private-answer"]])
        const key = current.runtime.decisions.key("question", question)
        const initial = current.runtime.decisions.state(key).status
        phase = "missing-page"
        await current.runtime.load()
        const afterPage = current.runtime.decisions.state(key).status
        const retained = current.runtime.state.retained.length
        phase = "resolved"
        await current.runtime.check(current.runtime.state.retained[0]!)
        first = {
          initial,
          afterPage,
          retained,
          notice: current.runtime.notice(),
          afterWinner: current.runtime.state.retained.length,
          available: current.runtime.state.retained[0]?.available,
          storedSecret: Object.values(localStorage).join(" ").includes("private-answer"),
        }
      } finally {
        current.dispose()
      }
      phase = "pending"
      lookup = "not_dispatched"
      const reloaded = mount()
      try {
        await reloaded.runtime.load()
        const visible = reloaded.runtime.visible().length
        const blocked = reloaded.runtime.blocked().length
        await reloaded.runtime.check(reloaded.runtime.state.retained[0]!, true)
        const retryable = reloaded.runtime.retryable().size
        const question = {
          id: "still-mounted-password",
          sessionID: "session-one",
          questions: native.questions.map((item) => ({ ...item, options: [] })),
        }
        reloaded.runtime.decisions.updateDraft(question, (draft) => ({
          ...draft,
          custom: ["denied-live-answer"],
          source: ["custom"],
        }))
        denied = true
        await reloaded.runtime.load()
        return {
          ...first,
          visible,
          blocked,
          submitted,
          retryable,
          invalidated: !reloaded.runtime.active(),
          remaining: reloaded.runtime.state.retained.length,
          deniedDraft: reloaded.runtime.decisions.draft(question).custom,
        }
      } finally {
        reloaded.dispose()
      }
    })
    expect(result.initial).toBe("unknown")
    expect(result.afterPage).toBe("unknown")
    expect(result.retained).toBe(1)
    expect(result.notice).toMatchObject({ state: "resolved", winner: { actor: { displayName: "Another member" } } })
    expect(result.afterWinner).toBe(1)
    expect(result.available).toBe(false)
    expect(result.storedSecret).toBe(false)
    expect(result.visible).toBe(0)
    expect(result.blocked).toBe(1)
    expect(result.submitted).toBe(1)
    expect(result.retryable).toBe(0)
    expect(result.invalidated).toBe(true)
    expect(result.remaining).toBe(0)
    expect(result.deniedDraft).toEqual([""])
  } finally {
    await page.close()
  }
})

test("pending pagination passes the residency window without losing the selected native request or continuation", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.decisionRuntimeFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationInteractionRuntime, createOrganizationClient, createRoot } =
        window.decisionRuntimeFixture
      const binding = {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        creatorID: "account-one",
        driverRuntimeID: "runtime-one",
        bindingEpoch: 1,
      } as const
      let last = 0
      const api = createOrganizationClient({
        baseUrl: "https://organization.example",
        fetch: Object.assign(
          async (input: RequestInfo | URL) => {
            const query = await new Request(input).json()
            const start = query.cursor ? Number(query.cursor) : 0
            last = start
            return Response.json({
              rootSessionID: "session-one",
              sourceSessionID: "session-one",
              binding,
              runtimeKind: "member",
              operation: "pending",
              items: Array.from({ length: 32 }, (_, index) => ({
                kind: "permission",
                requestID: `permission-${start + index}`,
                sourceSessionID: "session-one",
                permission: "bash",
                patterns: [],
                alwaysScope: "runtime",
              })),
              hasMore: start + 32 < 160,
              cursor: start + 32 < 160 ? String(start + 32) : undefined,
            })
          },
          { preconnect() {} },
        ),
      })
      const scope = createRoot((dispose) => ({
        dispose,
        runtime: createOrganizationInteractionRuntime({
          api,
          accountID: "account-one",
          connectionKey: "runtime-page",
          rootSessionID: "session-one",
          binding,
          signal: new AbortController().signal,
        }),
      }))
      try {
        await scope.runtime.load()
        scope.runtime.decisions.select(
          "session-one",
          scope.runtime.decisions.key("permission", { id: "permission-0", sessionID: "session-one" }),
        )
        for (let index = 0; index < 4; index++) await scope.runtime.load(true)
        const after = {
          last,
          count: scope.runtime.visible().length,
          selected: scope.runtime.visible().some((row) => row.requestID === "permission-0"),
          tail: scope.runtime.visible().some((row) => row.requestID === "permission-159"),
        }
        const ids = scope.runtime.visible().map((row) => row.requestID)
        await scope.runtime.load(false, true)
        const polled = {
          ids: scope.runtime.visible().map((row) => row.requestID),
          cursor: scope.runtime.cursor(),
          earlier: scope.runtime.earlier(),
        }
        await scope.runtime.load()
        const first = {
          count: scope.runtime.visible().length,
          first: scope.runtime.visible()[0]?.requestID,
          cursor: scope.runtime.cursor(),
          earlier: scope.runtime.earlier(),
        }
        return { after, ids, polled, first }
      } finally {
        scope.dispose()
      }
    })
    expect(result.after).toEqual({ last: 128, count: 128, selected: true, tail: true })
    expect(result.polled.ids).toEqual(result.ids)
    expect(result.polled.cursor).toBeUndefined()
    expect(result.polled.earlier).toBe(true)
    expect(result.first).toEqual({ count: 32, first: "permission-0", cursor: "32", earlier: false })
  } finally {
    await page.close()
  }
})

test("an original response outside the displayed recovery page still blocks its exact native form", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.decisionRuntimeFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationInteractionRuntime, createOrganizationClient, createRoot } =
        window.decisionRuntimeFixture
      const { createOrganizationDecisionOutbox } = window.decisionOutboxFixture
      const binding = {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        creatorID: "account-one",
        driverRuntimeID: "runtime-one",
        bindingEpoch: 1,
      } as const
      const owner = {
        connectionKey: "off-page",
        accountID: "account-one",
        projectID: "project-one",
        rootSessionID: "session-one",
        sourceSessionID: "session-one",
      }
      const outbox = createOrganizationDecisionOutbox({ owner, binding })
      for (let index = 0; index < 64; index++) {
        const id = String(index).padStart(3, "0")
        await outbox.begin(
          {
            schemaVersion: 1,
            orgID: binding.orgID,
            projectID: binding.projectID,
            runtimeID: binding.driverRuntimeID,
            sessionID: owner.rootSessionID,
            requestID: `logical-${id}`,
            decision: { operation: "decision", kind: "permission", requestID: `native-${id}`, reply: "once" },
          },
          false,
        )
      }
      outbox.dispose()
      const api = createOrganizationClient({
        baseUrl: "https://organization.example",
        fetch: Object.assign(
          async () =>
            Response.json({
              rootSessionID: owner.rootSessionID,
              sourceSessionID: owner.sourceSessionID,
              binding,
              runtimeKind: "member",
              operation: "pending",
              items: [
                {
                  kind: "permission",
                  requestID: "native-063",
                  sourceSessionID: owner.sourceSessionID,
                  permission: "bash",
                  patterns: [],
                  alwaysScope: "runtime",
                },
              ],
              hasMore: false,
            }),
          { preconnect() {} },
        ),
      })
      const scope = createRoot((dispose) => ({
        dispose,
        runtime: createOrganizationInteractionRuntime({ api, ...owner, binding, signal: new AbortController().signal }),
      }))
      try {
        await scope.runtime.load()
        const first = {
          visible: scope.runtime.visible().length,
          last: scope.runtime.state.retained.at(-1)?.nativeID,
          count: scope.runtime.blocked().length,
        }
        await scope.runtime.retainedPage(true)
        return {
          first,
          second: {
            visible: scope.runtime.visible().length,
            last: scope.runtime.state.retained.at(-1)?.nativeID,
            count: scope.runtime.blocked().length,
          },
          cursor: scope.runtime.outboxCursor(),
        }
      } finally {
        scope.dispose()
      }
    })
    expect(result.first).toEqual({ visible: 0, last: "native-031", count: 32 })
    expect(result.second).toEqual({ visible: 0, last: "native-063", count: 32 })
    expect(result.cursor).toBeUndefined()
  } finally {
    await page.close()
  }
})

test("explicit sign-out removes only the captured connection's real durable responses", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => !!window.decisionRuntimeFixture)
    const result = await page.evaluate(async () => {
      const { createOrganizationConnections } = window.decisionRuntimeFixture
      const { createOrganizationDecisionOutbox } = window.decisionOutboxFixture
      const tokens = {
        issuer: "https://organization.example",
        orgID: "org-one",
        deploymentIncarnation: "deployment",
        clientID: "web",
        account: {
          accountID: "account-one",
          orgID: "org-one",
          loginName: "member",
          displayName: "Member",
          role: "member",
          state: "active",
          revision: 1,
          authRevision: 1,
          createdAt: 0,
        },
        tokenType: "Bearer",
        accessToken: "a".repeat(64),
        expiresAt: 60001,
      } as const
      const registry = createOrganizationConnections({
        storage: localStorage,
        origins: [tokens.issuer],
        redirectUri: "https://app.example/organization.html",
        authorize: async () => tokens,
        fetch: Object.assign(async () => Response.json({ ok: true }), { preconnect() {} }),
      })
      await registry.connect({ issuer: tokens.issuer, clientID: tokens.clientID })
      const connectionKey = registry.current()!.key
      const owner = {
        connectionKey,
        accountID: "account-one",
        projectID: "project-one",
        rootSessionID: "session-one",
        sourceSessionID: "session-one",
      }
      const binding = {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        creatorID: "account-one",
        driverRuntimeID: "runtime-one",
        bindingEpoch: 1,
      } as const
      const command = {
        schemaVersion: 1,
        orgID: "org-one",
        projectID: "project-one",
        runtimeID: "runtime-one",
        sessionID: "session-one",
        requestID: "signout-logical",
        decision: { operation: "decision", kind: "permission", requestID: "signout-native", reply: "once" },
      } as const
      const own = createOrganizationDecisionOutbox({ owner, binding })
      const other = createOrganizationDecisionOutbox({
        owner: { ...owner, connectionKey: "other-connection" },
        binding,
      })
      try {
        await own.begin(command, false)
        await other.begin(command, false)
        await registry.signOut(connectionKey)
        return {
          state: registry.connection(connectionKey)?.state,
          own: (await own.page()).items.length,
          other: (await other.page()).items.length,
        }
      } finally {
        own.dispose()
        other.dispose()
        registry.dispose()
      }
    })
    expect(result).toEqual({ state: "signed_out", own: 0, other: 1 })
  } finally {
    await page.close()
  }
})

import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import { organizationCommandFixtureSource } from "../support/organization-command-fixture"
import {
  OrganizationCommandProtocol as Command,
  type OrganizationDesktop as Desktop,
} from "@ericsanchezok/synergy-organization-protocol"

declare global {
  interface Window {
    questionDraftBodyReads: number
  }
}

let browser: Browser
let fixture: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
const connection: Desktop.Connection = {
  id: "a".repeat(64),
  issuer: "https://a.example",
  clientID: "desktop",
  orgID: "org-a",
  deploymentIncarnation: "deployment-a",
  account: {
    accountID: "account-a",
    orgID: "org-a",
    loginName: "reader",
    displayName: "Reader",
    role: "member",
    state: "active",
    revision: 1,
    authRevision: 1,
    createdAt: 0,
  },
  state: "ready",
}
const binding = {
  schemaVersion: 1,
  orgID: "org-a",
  projectID: "project-a",
  creatorID: "account-a",
  driverRuntimeID: "runtime-a",
  bindingEpoch: 1,
} as const
beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-interactions-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {Show} from "solid-js"
    import {AppBaseProviders} from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import {PlatformProvider} from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    import {SpaceProvider,useSpace} from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)}
    import {OrganizationSessionInteractions} from ${JSON.stringify(`/@fs/${source}/organization/interactions.tsx`)}
    ${organizationCommandFixtureSource}
    const platform={platform:"web",openLink(){},fetch:async()=>Response.json({healthy:false}),organization:{list:()=>window.hostList(),request:value=>window.hostRequest(value),commandStream,cancel:value=>{commandTransfers.delete(value.requestID);return Promise.resolve({ok:true})}}}
    function Fixture(){const space=useSpace();return <Show when={space.current()?.identity.kind === "organization"}><main style={{padding:"16px"}}><OrganizationSessionInteractions sessionID="session-a" binding={${JSON.stringify(binding)}} online={true}/></main></Show>}
    render(()=><PlatformProvider value={platform}><AppBaseProviders><SpaceProvider><Fixture/></SpaceProvider></AppBaseProviders></PlatformProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})
const url = () => new URL("/organization/org-a/account-a/deployment-a", fixture.url).href
function pending(kind: "permission" | "question") {
  return kind === "permission"
    ? {
        kind,
        requestID: "native-a",
        sourceSessionID: "session-a",
        permission: "bash",
        patterns: ["/approved/project/**"],
        alwaysScope: "runtime",
      }
    : {
        kind,
        requestID: "native-a",
        sourceSessionID: "session-a",
        questions: [
          { header: "Private answer", question: "Enter the required password", options: [], input_type: "password" },
        ],
      }
}
const envelope = { rootSessionID: "session-a", sourceSessionID: "session-a", binding, runtimeKind: "hosted" }
const success = (body: unknown) => ({ ok: true, value: { status: 200, body: JSON.stringify(body) } })

test("hosted permission scope names all members and first-winner feedback reflects the actual native decision", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  let response: Command.DecisionRequest | undefined
  let replies = 0
  await page.exposeFunction("hostList", () => ({ ok: true, value: [connection] }))
  await page.exposeFunction("hostRequest", async (request: Desktop.Request) => {
    const query = request.body ? JSON.parse(request.body) : undefined
    if (request.path.endsWith("/interactions/reply")) {
      response = Command.DecisionRequest.parse(query)
      replies++
      const permit: Command.Permit = {
        schemaVersion: 1,
        purpose: "session-command",
        orgID: "org-a",
        deploymentIncarnation: "deployment-a",
        keyID: "key",
        requestID: response.requestID,
        payloadHash: await Command.digestDecision(response),
        sessionID: "session-a",
        projectID: "project-a",
        runtimeID: "runtime-a",
        bindingEpoch: 1,
        connectionEpoch: 1,
        commandSeq: 1,
        shareGeneration: 0,
        controlRevision: 0,
        authRevision: 1,
        admissionID: "admission",
        attemptID: "attempt",
        operation: "decision",
        authorizedAt: 1,
        deadline: 30001,
        actor: {
          kind: "account",
          subjectID: "account-a",
          displayName: "Reader",
          clientKind: "desktop",
          requestID: response.requestID,
          orgID: "org-a",
        },
      }
      return success({
        schemaVersion: 1,
        permit,
        acceptedAt: 2,
        intakeSeq: 1,
        effect: {
          kind: "decision",
          sourceSessionID: "session-a",
          requestID: "native-a",
          decision: {
            status: "already_resolved",
            winner: {
              sessionID: "session-a",
              requestID: "native-a",
              actor: {
                kind: "account",
                subjectID: "another-account",
                displayName: "Another member",
                clientKind: "web",
                requestID: "another-logical",
                orgID: "org-a",
              },
              decidedAt: 2,
              outcome: { kind: "permission", reply: "reject" },
            },
          },
        },
      })
    }
    return success({
      ...envelope,
      operation: query.operation,
      ...(query.operation === "pending"
        ? { items: replies ? [] : [pending("permission")], hasMore: false }
        : { items: [{ identity: { kind: "permission", requestID: "native-a" }, state: "pending" }] }),
    })
  })
  try {
    await page.goto(url())
    await page.getByRole("button", { name: "Expand request", exact: true }).click()
    await page.getByRole("button", { name: "More allow options", exact: true }).click()
    await page.getByText(/all members in every project on this hosted Runtime/).waitFor()
    await page.getByRole("button", { name: /^Always allow/ }).click()
    await page.getByText("Denied by Another member.", { exact: true }).waitFor()
    expect(response?.decision).toMatchObject({ kind: "permission", reply: "always", requestID: "native-a" })
    expect(replies).toBe(1)
    expect(await page.getByRole("button", { name: "Allow once", exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await page.close()
  }
})

test("a lost password response restores only its identity and cannot submit a different answer after reload", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } })
  let replies = 0
  let logicalID: string | undefined
  await page.exposeFunction("hostList", () => ({ ok: true, value: [connection] }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const query = request.body ? JSON.parse(request.body) : undefined
    if (request.path.endsWith("/interactions/reply")) {
      replies++
      logicalID = query.requestID
      return { ok: true, value: { status: 504, body: JSON.stringify({ code: "COMMAND_OUTCOME_UNKNOWN" }) } }
    }
    if (request.path.includes("/commands/"))
      return success({ requestID: logicalID, attemptID: "attempt", state: "not_dispatched", authorizedAt: 1 })
    return success({
      ...envelope,
      operation: query.operation,
      ...(query.operation === "pending"
        ? { items: [pending("question")], hasMore: false }
        : { items: [{ identity: { kind: "question", requestID: "native-a" }, state: "pending" }] }),
    })
  })
  try {
    await page.goto(url())
    await page.locator('input[type="password"]').fill("Do not persist the raw answer", { timeout: 1500 })
    expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain(
      "Do not persist the raw answer",
    )
    await page.reload()
    await page.locator('input[type="password"]').waitFor()
    expect(await page.locator('input[type="password"]').inputValue()).toBe("")
    await page.locator('input[type="password"]').fill("Do not persist the raw answer")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByText("The response status is unconfirmed.", { exact: true }).waitFor()
    expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain(
      "Do not persist the raw answer",
    )
    await page.reload()
    await page.getByText(/original password answer was kept only in memory/).waitFor()
    expect(await page.locator('input[type="password"]').count()).toBe(0)
    await page.getByRole("button", { name: "Check response status", exact: true }).click()
    expect(await page.getByRole("button", { name: "Retry original response", exact: true }).count()).toBe(0)
    expect(replies).toBe(1)
  } finally {
    await page.close()
  }
})

test("opening a question queue reads only the selected saved answer and restores a later edit by identity", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } })
  const connectionKey = JSON.stringify([
    "organization",
    connection.orgID,
    connection.account.accountID,
    connection.deploymentIncarnation,
  ])
  const { Persist } = await import("../../src/utils/persist")
  const target = Persist.workspace(Persist.scopeKey(connectionKey, "project-a"), "question-drafts-v2")
  const legacyKey = `${target.storage}:${target.key}`
  await page.addInitScript(
    ({ legacyKey }) => {
      const entries = Object.fromEntries(
        Array.from({ length: 160 }, (_, index) => [
          JSON.stringify(["session-a", `question-${String(index).padStart(3, "0")}`]),
          {
            step: 0,
            selections: [[]],
            custom: [`Saved answer ${index} ` + "x".repeat(4096)],
            source: ["custom"],
            inputTypes: ["text"],
          },
        ]),
      )
      localStorage.setItem(legacyKey, JSON.stringify({ version: 2, entries }))
      window.questionDraftBodyReads = 0
      const original = IDBObjectStore.prototype.get
      IDBObjectStore.prototype.get = function (query) {
        if (this.name === "drafts") window.questionDraftBodyReads++
        return original.call(this, query)
      }
    },
    { legacyKey },
  )
  await page.exposeFunction("hostList", () => ({ ok: true, value: [connection] }))
  await page.exposeFunction("hostRequest", (request: Desktop.Request) => {
    const query = JSON.parse(request.body!)
    if (query.operation === "pending")
      return success({
        ...envelope,
        operation: "pending",
        items: Array.from({ length: 32 }, (_, index) => ({
          kind: "question",
          requestID: `question-${String(index).padStart(3, "0")}`,
          sourceSessionID: "session-a",
          questions: [{ header: `Question ${index}`, question: `Question ${index}`, options: [] }],
        })),
        hasMore: false,
      })
    return success({
      ...envelope,
      operation: "decisions",
      items: query.identities.map((identity: { kind: string; requestID: string }) => ({ identity, state: "pending" })),
    })
  })
  try {
    await page.goto(url())
    const input = page.getByRole("textbox", { name: "Other answer", exact: true })
    await page.waitForFunction(() =>
      document.querySelector<HTMLTextAreaElement>("textarea")?.value.startsWith("Saved answer 0 "),
    )
    expect(await page.evaluate(() => window.questionDraftBodyReads)).toBe(1)
    await page.getByRole("button", { name: "Pending 32", exact: true }).click()
    await page.getByRole("button", { name: /Question 31/ }).waitFor()
    expect(await page.evaluate(() => window.questionDraftBodyReads)).toBe(1)
    await page.getByRole("button", { name: /Question 31/ }).click()
    await page.waitForFunction(() =>
      document.querySelector<HTMLTextAreaElement>("textarea")?.value.startsWith("Saved answer 31 "),
    )
    expect(await page.evaluate(() => window.questionDraftBodyReads)).toBe(2)
    await input.fill("Edited active answer")
    await page.waitForFunction(async (connectionKey) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("synergy.organization-question-drafts", 1)
        opening.onsuccess = () => resolve(opening.result)
        opening.onerror = () => reject(opening.error)
      })
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const request = database
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .get([connectionKey, "account-a", "project-a", "session-a", "question-031"])
          request.onsuccess = () => resolve(request.result?.draft.custom[0] === "Edited active answer")
          request.onerror = () => reject(request.error)
        })
      } finally {
        database.close()
      }
    }, connectionKey)
    await page.reload()
    await page.getByRole("button", { name: "Pending 32", exact: true }).click()
    await page.getByRole("button", { name: /Question 31/ }).click()
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "Edited active answer",
    )
    expect(await input.inputValue()).toBe("Edited active answer")
  } finally {
    await page.close()
  }
})

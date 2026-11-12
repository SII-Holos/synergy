import { beforeAll, afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationResourceProtocol as Resource,
  OrganizationCloudProtocol as Cloud,
  type OrganizationDesktop as Desktop,
} from "@ericsanchezok/synergy-organization-protocol"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

let browser: Browser
let fixture: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")
const account = {
  accountID: "account-a",
  orgID: "org-a",
  loginName: "operator",
  displayName: "Operator",
  role: "member" as const,
  state: "active" as const,
  revision: 1,
  authRevision: 1,
  createdAt: 0,
}
const entry: Desktop.Connection = {
  id: "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  issuer: "https://organization.example",
  clientID: "desktop",
  orgID: "org-a",
  deploymentIncarnation: "deployment-a",
  account,
  state: "ready",
}
const runtime = (id: string) => ({
  runtimeID: id,
  orgID: entry.orgID,
  deploymentIncarnation: entry.deploymentIncarnation,
  publicKey: "a".repeat(64),
  state: "active" as const,
  revision: 1,
  connectionEpoch: 1,
  createdAt: 0,
  runtimeKind: "member" as const,
  accountID: account.accountID,
  deviceID: id === "source" ? "Source computer" : "Destination computer",
})
const tuple = {
  schemaVersion: 1 as const,
  orgID: entry.orgID,
  deploymentIncarnation: entry.deploymentIncarnation,
  sessionID: "session-a",
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  fromEpoch: 7,
  toEpoch: 8,
  mappingPlanRevision: 1,
  shareGeneration: 0,
}
const requirements = [
  { code: "source_freeze", label: "Waiting for the source to pause and drain", recoverable: true },
  { code: "target_prepare", label: "Waiting for destination preparation", recoverable: true },
]
const result = (value: unknown) => ({ ok: true, value: { status: 200, body: JSON.stringify(value) } })
async function capture(page: Page, name: string) {
  const output = process.env.SYNERGY_UI_SCREENSHOT_DIR
  if (!output) return
  await fs.mkdir(output, { recursive: true })
  await page.screenshot({ path: path.join(output, name) })
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-handoff-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"; import {Show,createSignal} from "solid-js";
    import {AppBaseProviders} from ${JSON.stringify(`/@fs/${source}/app.tsx`)};
    import {SpaceProvider,useSpace} from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)};
    import {PlatformProvider} from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)};
    import {OrganizationHandoff} from ${JSON.stringify(`/@fs/${source}/organization/handoff.tsx`)};
    import {useConfirm} from ${JSON.stringify(`/@fs/${source}/components/dialog/confirm-dialog.tsx`)};
    const platform={platform:"web",openLink(){},fetch:async()=>Response.json({healthy:false}),organization:{protocolVersion:2,list:()=>window.hostList(),request:async value=>{const result=await window.hostRequest(value);window.handoffResponses=(window.handoffResponses??0)+1;return result},cancel:()=>Promise.resolve({ok:true}),startMember:()=>{throw new Error("No automatic runtime start")}}};
    function Fixture(){const space=useSpace();const [execute,setExecute]=createSignal(true);const other=useConfirm();window.revoke=()=>setExecute(false);window.openOther=()=>other.show({title:"Unrelated confirmation",description:"Keep this dialog",confirmLabel:"Confirm",tone:"neutral",onConfirm(){}});const session={sessionID:"session-a",projectID:"project-a",creatorID:new URLSearchParams(location.search).has("cloud")?"account-a":"different-creator",driverRuntimeID:"source",bindingEpoch:7,shareState:"shared",resourceIDs:[],createdAt:0,get permissions(){return {read:true,execute:execute(),stop:true}},runtime:{runtimeID:"source",runtimeKind:"member",ownerID:"account-a",state:"online",connectionEpoch:1}};return <Show when={space.current()?.key} keyed>{()=> <OrganizationHandoff session={session} changed={()=>window.hostChanged()} compact={new URLSearchParams(location.search).has("compact")} />}</Show>}
    render(()=> <PlatformProvider value={platform}><AppBaseProviders><SpaceProvider><Fixture/></SpaceProvider></AppBaseProviders></PlatformProvider>,document.getElementById("root"));
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

async function open(
  input: {
    cloud?: boolean
    locale?: string
    drop?: "prepare" | "prepare-source" | "permit" | "cancel"
    viewport?: { width: number; height: number }
    colorScheme?: "light" | "dark"
    empty?: boolean
    compact?: boolean
    object?: boolean
    rejectPrepare?: boolean
    denyStorage?: boolean
    blocked?: boolean
    holdOptions?: Promise<void>
  } = {},
) {
  const page = await browser.newPage({
    viewport: input.viewport ?? { width: 1100, height: 760 },
    colorScheme: input.colorScheme ?? "light",
    locale: input.locale ?? "en-US",
  })
  page.setDefaultTimeout(5000)
  if (input.denyStorage)
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key.includes("organization-handoff"))
          throw new DOMException("Fixture storage is full", "QuotaExceededError")
        original.call(this, key, value)
      }
    })
  const requests: Array<{ path: string; method: string; body: unknown }> = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let view: Handoff.View | undefined
  let dropped = false
  let changed = 0
  let issued = 0
  let rejected = false
  let controlRevision = 11
  let blockedOnce = false
  const permits = new Map<string, unknown>()
  const target = input.cloud
    ? {
        ...runtime("target"),
        runtimeKind: "hosted",
        name: "Hosted destination",
        createdBy: account.accountID,
        accountID: undefined,
        deviceID: undefined,
      }
    : runtime("target")
  await page.exposeFunction("hostList", () => ({
    ok: true,
    value: [
      entry,
      { ...entry, id: "b".repeat(64), orgID: "org-b", account: { ...account, orgID: "org-b", accountID: "account-b" } },
    ],
  }))
  await page.exposeFunction("hostChanged", () => {
    changed++
  })
  await page.exposeFunction("hostRequest", async (request: Desktop.Request) => {
    const url = new URL(request.path, entry.issuer)
    const body = request.body ? JSON.parse(request.body) : undefined
    requests.push({ path: url.pathname + url.search, method: request.method, body })
    if (url.pathname === "/org/v1/runtimes")
      return result({
        items: input.empty ? [] : url.searchParams.has("cursor") ? [target] : [runtime("source")],
        ...(!input.empty && !url.searchParams.has("cursor") ? { cursor: "page-two" } : {}),
      })
    if (url.pathname === "/org/v1/runtimes/target") return result(target)
    if (url.pathname.endsWith("/handoff-options")) {
      if (input.holdOptions) await input.holdOptions
      return result({
        sessionID: "session-a",
        projectID: "project-a",
        bindingEpoch: 7,
        controlRevision,
        sourceRuntimeID: "source",
        targetRuntimeID: "target",
        source: input.cloud
          ? {
              kind: "organization",
              label: "Team files",
              reference: { workspaceID: "source-workspace", generation: 3, revision: 4 },
              resource: {
                resourceID: "workspace-storage",
                workspaceID: "source-workspace",
                generation: 3,
                path: "project",
              },
            }
          : {
              kind: "native",
              label: "Source project",
              reference: { workspaceID: "source-workspace", generation: 3, revision: 4 },
            },
        native: input.cloud
          ? null
          : {
              reference: { workspaceID: "default-target", generation: 1, revision: 1 },
              label: "Existing destination project folder",
              projectRevision: "a".repeat(64),
            },
        choices: [
          {
            kind: input.cloud ? "organization-live" : input.object ? "organization-object" : "native",
            requiresDifference: false,
          },
          { kind: "organization-native", requiresDifference: true },
        ],
      })
    }
    if (url.pathname.endsWith("/handoffs") && request.method === "GET") return result({ items: view ? [view] : [] })
    if (url.pathname.endsWith("/handoffs") && request.method === "POST") {
      const prepared = Handoff.CurrentPrepare.parse(body)
      if (input.rejectPrepare && !rejected) {
        rejected = true
        controlRevision = 12
        return {
          ok: true,
          value: {
            status: 409,
            body: JSON.stringify({
              code: "REVISION_CONFLICT",
              outcome: "not_dispatched",
              retryable: false,
              currentRevision: 12,
              message: "Fixture control advanced",
            }),
          },
        }
      }
      view = Handoff.View.parse({
        ...tuple,
        handoffID: prepared.handoffID,
        targetAccepted: !!input.cloud,
        cancelRequested: false,
        canAccept: !input.cloud,
        phase: "preparing",
        initiator: account.accountID,
        commandSeq: 4,
        missingRequirements: requirements,
        canCancel: true,
        canContinue: false,
        currentDriver: "source",
        bindingEpoch: 7,
        workspaceMapping: prepared.workspaceMapping,
        mappingHash: "a".repeat(64),
      })
      if (input.drop === "prepare" && !dropped) {
        dropped = true
        return { ok: false, error: { code: "unavailable" } }
      }
      return result(view)
    }
    if (url.pathname === "/org/v1/projects/project-a/resources") {
      const allowed = url.searchParams.has("cursor")
      return result({
        items: [
          Resource.View.parse({
            resourceID: allowed ? "storage-allowed" : "storage-denied",
            orgID: entry.orgID,
            scope: { kind: "organization" },
            kind: "workspace",
            name: allowed ? "Project storage" : "Forbidden storage",
            state: "enabled",
            revision: 1,
            createdAt: 0,
            updatedAt: 0,
            definition: { protocol: "workspace-storage" },
            permissions: { use: allowed },
          }),
        ],
        ...(!allowed ? { cursor: "resources-two" } : {}),
      })
    }
    if (url.pathname === "/org/v1/projects/project-a/cloud/workspaces") {
      const active = !url.searchParams.has("cursor")
      return result({
        items: [
          Cloud.Workspace.parse({
            workspaceID: active ? "workspace-active" : "workspace-inactive",
            orgID: entry.orgID,
            projectID: "project-a",
            resourceID: "storage-allowed",
            name: active ? "Busy workspace" : "Archive workspace",
            revision: 12,
            generation: 4,
            contentRevision: 6,
            manifest: null,
            activeMount: active,
          }),
        ],
        ...(active ? { cursor: "workspaces-two" } : {}),
      })
    }
    if (view && url.pathname === `/org/v1/handoffs/${view.handoffID}`) return result(view)
    if (view && url.pathname.endsWith("/accept")) {
      view = { ...view, targetAccepted: true, canAccept: false }
      return result(view)
    }
    if (view && url.pathname.endsWith("/permit")) {
      const purpose = Handoff.PermitRequest.parse(body).purpose
      if (!permits.has(purpose)) {
        issued++
        permits.set(purpose, {
          permit: {
            ...tuple,
            handoffID: view.handoffID,
            purpose,
            permitID: purpose,
            keyID: "service-key",
            manifestHash: "b".repeat(64),
            preparedHash: "c".repeat(64),
            createdAt: 0,
          },
          signature: "d".repeat(128),
        })
      }
      if (purpose === "handoff-activation") view = { ...view, phase: "activation_permitted" }
      if (input.drop === "permit" && !dropped) {
        dropped = true
        return { ok: false, error: { code: "unavailable" } }
      }
      return result(permits.get(purpose))
    }
    if (view && url.pathname.endsWith("/commit")) {
      view = { ...view, phase: "committed", currentDriver: "target", bindingEpoch: 8, canCancel: false }
      return result(view)
    }
    if (view && url.pathname.endsWith("/cancel")) {
      view = { ...view, cancelRequested: true }
      if (input.drop === "cancel" && !dropped) {
        dropped = true
        return { ok: false, error: { code: "unavailable" } }
      }
      return result(view)
    }
    if (view && url.pathname.endsWith("/drive")) {
      const operation = Handoff.Drive.parse(body)
      if (
        input.blocked &&
        ((operation.operation === "prepare-source" && !blockedOnce) || operation.operation === "inspect-source")
      ) {
        blockedOnce = true
        return result({
          handoffID: view.handoffID,
          requestID: operation.requestID,
          runtimeID: "source",
          operation: operation.operation,
          state: "blocked",
          stage: "preparing",
          revision: "f".repeat(64),
          requirements: [
            {
              code: operation.cursor ? "second" : "first",
              label: operation.cursor ? "Second native requirement" : "First native requirement",
              recoverable: true,
            },
          ],
          ...(!operation.cursor ? { requirementsCursor: "requirements-two" } : {}),
          facts: [],
        })
      }
      let stage: Handoff.MachineResult["stage"] = "idle"
      if (operation.operation === "prepare-source" || operation.operation === "inspect-source") {
        stage = "source-frozen"
        view = {
          ...view,
          missingRequirements: requirements.filter((requirement) => requirement.code !== "source_freeze"),
        }
      }
      if (operation.operation === "prepare-target") {
        stage = "target-prepared"
        view = { ...view, phase: "prepared", missingRequirements: [] }
      }
      if (operation.operation === "surrender-source") {
        stage = "source-surrendered"
        view = { ...view, phase: "surrendered", canCancel: false, cancelRequested: false }
      }
      if (operation.operation === "activate-target") {
        stage = "target-activated"
        view = { ...view, phase: "completed", canContinue: true }
      }
      if (operation.operation === "cancel-source") {
        stage = "source-cancelled"
        view = { ...view, phase: "cancelled", canCancel: false }
      }
      if (operation.operation === "retire-target") {
        stage = "target-never-activate"
        view = { ...view, phase: "retired", canContinue: false }
      }
      if (input.drop === "prepare-source" && operation.operation === "prepare-source" && !dropped) {
        dropped = true
        return { ok: false, error: { code: "unavailable" } }
      }
      return result({
        handoffID: view.handoffID,
        requestID: operation.requestID,
        runtimeID: operation.operation.endsWith("-source") ? "source" : "target",
        operation: operation.operation,
        state: "complete",
        stage,
        revision: "e".repeat(64),
        requirements: [],
        facts: [],
      })
    }
    throw new Error(`Unexpected fixture request ${request.method} ${url.pathname}`)
  })
  const query = new URLSearchParams({
    ...(input.cloud ? { cloud: "" } : {}),
    ...(input.compact ? { compact: "" } : {}),
  })
  await page.goto(new URL(`/organization/org-a/account-a/deployment-a?${query}`, fixture.url).href)
  if (input.compact) await page.getByRole("button", { name: "Conversation actions", exact: true }).click()
  if (input.locale?.startsWith("zh")) await page.waitForFunction(() => document.documentElement.lang === "zh-CN")
  const opener = input.locale?.startsWith("zh")
    ? page.getByRole("button").first()
    : page.getByRole("button", { name: "Move conversation", exact: true })
  await opener.waitFor()
  const title = await opener.innerText()
  await opener.click()
  const dialog = page.getByRole("dialog", { name: title, exact: true })
  await dialog.waitFor()
  return {
    page,
    dialog,
    requests,
    errors,
    get changed() {
      return changed
    },
    get issued() {
      return issued
    },
  }
}
async function choose(f: Awaited<ReturnType<typeof open>>) {
  await f.dialog.getByRole("button", { name: "Load more", exact: true }).click()
  await f.dialog.getByRole("button", { name: /^Destination:/ }).click()
  await f.page.getByRole("option", { name: /Destination computer|Hosted destination/ }).click()
  await f.page
    .getByRole("listbox", { name: "Destination", exact: true, includeHidden: true })
    .waitFor({ state: "hidden" })
  await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).waitFor()
}
async function prepare(f: Awaited<ReturnType<typeof open>>) {
  await choose(f)
  await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
  await f.dialog.getByRole("heading", { name: "Preparing the move", exact: true }).waitFor()
  if (await f.dialog.getByRole("button", { name: "Accept this move", exact: true }).count())
    await f.dialog.getByRole("button", { name: "Accept this move", exact: true }).click()
  await f.dialog.getByRole("button", { name: "Pause and prepare the source", exact: true }).click()
  await f.dialog.getByRole("button", { name: "Prepare the destination", exact: true }).click()
  await f.dialog.getByRole("button", { name: "Release the source", exact: true }).waitFor()
}
async function surrender(f: Awaited<ReturnType<typeof open>>) {
  await f.dialog.getByRole("button", { name: "Release the source", exact: true }).click()
  const confirm = f.page.getByRole("dialog", { name: "Release the source", exact: true })
  await confirm.getByRole("button", { name: "Release the source", exact: true }).click()
}

test("native move pages real directory choices, retains source files and activates only a paused destination for a non-creator driver", async () => {
  const f = await open()
  try {
    await choose(f)
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0)
    expect(await f.dialog.getByText("Existing destination project folder").count()).toBe(0)
    expect(await f.dialog.getByText(/Source files stay in place/).isVisible()).toBe(true)
    await capture(f.page, "handoff-native-light.png")
    await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Accept this move", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Pause and prepare the source", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Prepare the destination", exact: true }).click()
    const body = f.requests.find((request) => request.path.endsWith("/handoffs") && request.method === "POST")!.body
    expect(body).toMatchObject({
      expectedBindingEpoch: 7,
      expectedControlRevision: 11,
      workspaceMapping: { kind: "native" },
    })
    await surrender(f)
    await f.dialog.getByRole("button", { name: "Finish the move", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Activate the paused destination", exact: true }).click()
    await f.dialog.getByRole("heading", { name: "Conversation moved and paused" }).waitFor()
    expect(f.changed).toBe(1)
    expect(
      f.requests.some((request) => /commands|controls|environment|compute|project-resources/.test(request.path)),
    ).toBe(false)
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 45_000)

test("keep-cloud uses the inspected existing resource without requesting a new personal grant or compute", async () => {
  const f = await open({ cloud: true, viewport: { width: 375, height: 667 }, colorScheme: "dark" })
  try {
    await prepare(f)
    const body = f.requests.find((request) => request.path.endsWith("/handoffs") && request.method === "POST")!.body
    expect(body).toMatchObject({
      workspaceMapping: {
        kind: "organization-live",
        source: { workspaceID: "source-workspace", generation: 3 },
        resource: { resourceID: "workspace-storage", workspaceID: "source-workspace", generation: 3, path: "project" },
      },
    })
    expect(f.requests.some((request) => /\/resources|workspaces|environment|compute/.test(request.path))).toBe(false)
    expect(await f.dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(
      await f.dialog.locator(".organization-handoff-summary > div").evaluateAll((rows) =>
        rows.every((row) => {
          const term = row.querySelector("dt")!
          const value = row.querySelector("dd")!
          const range = document.createRange()
          range.selectNodeContents(term)
          return value.getBoundingClientRect().left - range.getBoundingClientRect().right >= 8
        }),
      ),
    ).toBe(true)
    await capture(f.page, "handoff-cloud-dark-375.png")
    await f.dialog.getByRole("button", { name: "Cancel move", exact: true }).click()
    await f.page
      .getByRole("dialog", { name: "Cancel move", exact: true })
      .getByRole("button", { name: "Cancel move", exact: true })
      .click()
    await f.dialog.getByRole("heading", { name: "Move cancelled; source remains paused" }).waitFor()
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 45_000)

test("unknown preparation survives reload and unknown native work is inspected instead of replayed", async () => {
  for (const drop of ["prepare", "prepare-source"] as const) {
    const f = await open({ drop })
    try {
      await choose(f)
      await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
      if (drop === "prepare-source") {
        await f.dialog.getByRole("button", { name: "Accept this move", exact: true }).click()
        await f.dialog.getByRole("button", { name: "Pause and prepare the source", exact: true }).click()
      }
      await f.dialog
        .getByText("The last operation has no confirmed outcome. Check this move before taking another step.")
        .waitFor()
      if (drop === "prepare") {
        await f.page.reload()
        await f.page.getByRole("button", { name: "Move conversation", exact: true }).click()
      } else await f.dialog.getByRole("button", { name: "Check move status", exact: true }).click()
      await f.page
        .getByRole("dialog", { name: "Move conversation", exact: true })
        .getByRole("button", { name: drop === "prepare" ? "Accept this move" : "Prepare the destination", exact: true })
        .waitFor()
      expect(
        f.requests.filter((request) => request.path.endsWith("/handoffs") && request.method === "POST"),
      ).toHaveLength(1)
      expect(
        f.requests.filter(
          (request) =>
            request.path.endsWith("/drive") &&
            request.body &&
            typeof request.body === "object" &&
            "operation" in request.body &&
            request.body.operation === "prepare-source",
        ),
      ).toHaveLength(drop === "prepare-source" ? 1 : 0)
      if (drop === "prepare-source")
        expect(
          f.requests.some(
            (request) =>
              request.path.endsWith("/drive") &&
              request.body &&
              typeof request.body === "object" &&
              "operation" in request.body &&
              request.body.operation === "inspect-source",
          ),
        ).toBe(true)
      expect(f.errors).toEqual([])
    } finally {
      await f.page.close()
    }
  }
}, 45_000)

test("a lost permit response requires explicit retrieval and a new release confirmation before any surrender", async () => {
  const f = await open({ drop: "permit" })
  try {
    await prepare(f)
    await surrender(f)
    await f.dialog.getByRole("button", { name: "Retrieve the original authorization", exact: true }).waitFor()
    const surrenderCalls = () =>
      f.requests.filter(
        (request) =>
          request.body &&
          typeof request.body === "object" &&
          "operation" in request.body &&
          request.body.operation === "surrender-source",
      )
    expect(surrenderCalls()).toHaveLength(0)
    await f.dialog.getByRole("button", { name: "Retrieve the original authorization", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Release the source", exact: true }).waitFor()
    expect(surrenderCalls()).toHaveLength(0)
    expect(f.issued).toBe(1)
    await surrender(f)
    await f.dialog.getByRole("button", { name: "Finish the move", exact: true }).waitFor()
    expect(surrenderCalls()).toHaveLength(1)
    expect(f.issued).toBe(1)
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 45_000)

test("empty, keyboard and narrow layouts stay reachable in both themes without opening unsupported directory adoption", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    const f = await open({ empty: true, viewport: { width: 375, height: 667 }, colorScheme })
    try {
      await f.dialog.getByText(/No other runtime is available/).waitFor()
      expect(await f.dialog.getByText(/No other runtime is available/).isVisible()).toBe(true)
      expect(await f.dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await f.page.keyboard.press("Escape")
      await f.dialog.waitFor({ state: "detached" })
      await f.page.waitForFunction(
        () =>
          document.activeElement?.tagName === "BUTTON" &&
          document.activeElement.textContent?.trim() === "Move conversation",
      )
      expect(
        await f.page
          .getByRole("button", { name: "Move conversation", exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true)
      expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0)
      expect(f.errors).toEqual([])
    } finally {
      await f.page.close()
    }
  }
}, 30_000)

test("a late preflight cannot reopen a move after switching organization owner", async () => {
  const held = Promise.withResolvers<void>()
  const f = await open({ holdOptions: held.promise })
  try {
    await f.dialog.getByRole("button", { name: "Load more", exact: true }).click()
    await f.dialog.getByRole("button", { name: /^Destination:/ }).click()
    await f.page.getByRole("option", { name: "Destination computer" }).click()
    await f.dialog.getByText("Checking the current workspaces…").waitFor()
    await f.page.evaluate(() => {
      history.pushState(null, "", "/organization/org-b/account-b/deployment-a")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await f.dialog.waitFor({ state: "detached" })
    const received = await f.page.evaluate(() => Number(Reflect.get(window, "handoffResponses") ?? 0))
    held.resolve()
    await f.page.waitForFunction(
      (received) => Number(Reflect.get(window, "handoffResponses") ?? 0) > received,
      received,
    )
    await f.page.getByRole("button", { name: "Move conversation", exact: true }).focus()
    await f.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(await f.page.getByRole("dialog").count()).toBe(0)
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0)
    expect(f.errors).toEqual([])
  } finally {
    held.resolve()
    await f.page.close()
  }
}, 30_000)

test("a definite unsent preparation is re-inspected while an unavailable durable recovery store blocks dispatch", async () => {
  const f = await open({ rejectPrepare: true })
  try {
    await choose(f)
    await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Retry", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Accept this move", exact: true }).waitFor()
    const bodies = f.requests
      .filter((request) => request.path.endsWith("/handoffs") && request.method === "POST")
      .map((request) => Handoff.CurrentPrepare.parse(request.body))
    expect(bodies.map((body) => body.expectedControlRevision)).toEqual([11, 12])
    expect(bodies[0].handoffID).not.toBe(bodies[1].handoffID)
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
  const unavailable = await open({ denyStorage: true })
  try {
    await choose(unavailable)
    await unavailable.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
    await unavailable.dialog.getByRole("alert").waitFor()
    expect(await unavailable.dialog.getByRole("button", { name: "Prepare move", exact: true }).isDisabled()).toBe(true)
    expect(unavailable.requests.filter((request) => request.method === "POST")).toHaveLength(0)
    expect(unavailable.errors).toEqual([])
  } finally {
    await unavailable.page.close()
  }
}, 30_000)

test("object storage mapping requires the actual authorized resource, dormant workspace and complete relative path", async () => {
  const f = await open({ object: true })
  try {
    await choose(f)
    expect(await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).isDisabled()).toBe(true)
    await f.dialog.getByRole("button", { name: "Load more", exact: true }).click()
    await f.dialog.getByRole("button", { name: /^Storage resource:/ }).click()
    expect(await f.page.getByRole("option", { name: "Forbidden storage" }).count()).toBe(0)
    await f.page.getByRole("option", { name: "Project storage", exact: true }).click()
    await f.dialog.getByText("No inactive workspace is available for this storage resource.").waitFor()
    await f.dialog.getByRole("button", { name: "Load more", exact: true }).click()
    await f.dialog.getByRole("button", { name: /^Choose an inactive workspace:/ }).click()
    expect(await f.page.getByRole("option", { name: "Busy workspace" }).count()).toBe(0)
    await f.page.getByRole("option", { name: "Archive workspace", exact: true }).click()
    const path = f.dialog.getByRole("textbox", { name: "New folder in this workspace", exact: true })
    await path.fill("../outside")
    expect(await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).isDisabled()).toBe(true)
    await path.fill("handoff-folder")
    await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
    await f.dialog.getByText("handoff-folder", { exact: true }).waitFor()
    const body = Handoff.CurrentPrepare.parse(
      f.requests.find((request) => request.path.endsWith("/handoffs") && request.method === "POST")!.body,
    )
    expect(body.workspaceMapping).toMatchObject({
      kind: "organization-object",
      source: { workspaceID: "source-workspace", generation: 3 },
      target: {
        resourceID: "storage-allowed",
        workspaceID: "workspace-inactive",
        generation: 4,
        expectedRevision: 12,
        path: "handoff-folder",
      },
      acceptedDiffHash: null,
    })
    expect(await f.dialog.getByText("Project storage", { exact: true }).isVisible()).toBe(true)
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 30_000)

test("execute revocation retires only this move's confirmation and never releases its source", async () => {
  const f = await open()
  try {
    await prepare(f)
    await f.dialog.getByRole("button", { name: "Release the source", exact: true }).click()
    const release = f.page.getByRole("dialog", { name: "Release the source", exact: true })
    await release.waitFor()
    await f.page.evaluate("window.openOther()")
    const other = f.page.getByRole("dialog", { name: "Unrelated confirmation", exact: true })
    await other.waitFor()
    await f.page.evaluate("window.revoke()")
    await release.waitFor({ state: "detached" })
    expect(await other.isVisible()).toBe(true)
    expect(f.requests.filter((request) => request.path.endsWith("/permit"))).toHaveLength(0)
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 30_000)

test("the compact conversation menu hands dialog focus back to its connected trigger", async () => {
  const f = await open({ compact: true, empty: true, viewport: { width: 375, height: 667 } })
  try {
    await f.dialog.getByText(/No other runtime is available/).waitFor()
    await f.page.keyboard.press("Escape")
    await f.dialog.waitFor({ state: "detached" })
    await f.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Conversation actions")
    await f.page.getByRole("button", { name: "Move conversation", exact: true }).waitFor({ state: "detached" })
    expect(await f.page.getByRole("button", { name: "Move conversation", exact: true }).count()).toBe(0)
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 30_000)

test("blocked native requirements page against the same revision and explicit retry retains its original request", async () => {
  const f = await open({ blocked: true })
  try {
    await choose(f)
    await f.dialog.getByRole("button", { name: "Prepare move", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Accept this move", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Pause and prepare the source", exact: true }).click()
    await f.dialog.getByText("First native requirement", { exact: true }).waitFor()
    await f.dialog.getByRole("button", { name: "More requirements", exact: true }).click()
    await f.dialog.getByText("Second native requirement", { exact: true }).waitFor()
    const inspector = f.requests.find(
      (request) =>
        request.path.endsWith("/drive") && request.body && typeof request.body === "object" && "cursor" in request.body,
    )
    expect(inspector?.body).toMatchObject({
      operation: "inspect-source",
      expectedRevision: "f".repeat(64),
      cursor: "requirements-two",
    })
    await f.dialog.getByRole("button", { name: "Retry the same operation", exact: true }).click()
    await f.dialog.getByRole("button", { name: "Prepare the destination", exact: true }).waitFor()
    const attempts = f.requests
      .filter(
        (request) =>
          request.path.endsWith("/drive") &&
          request.body &&
          typeof request.body === "object" &&
          "operation" in request.body &&
          request.body.operation === "prepare-source",
      )
      .map((request) => Handoff.Drive.parse(request.body))
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 30_000)

test("a lost cancellation acknowledgement survives reload and needs explicit original source confirmation", async () => {
  const f = await open({ drop: "cancel" })
  try {
    await prepare(f)
    await f.dialog.getByRole("button", { name: "Cancel move", exact: true }).click()
    await f.page
      .getByRole("dialog", { name: "Cancel move", exact: true })
      .getByRole("button", { name: "Cancel move", exact: true })
      .click()
    await f.dialog
      .getByText("The last operation has no confirmed outcome. Check this move before taking another step.")
      .waitFor()
    await f.page.reload()
    await f.page.getByRole("button", { name: "Move conversation", exact: true }).click()
    const recovered = f.page.getByRole("dialog", { name: "Move conversation", exact: true })
    await recovered.getByRole("button", { name: "Confirm source cancellation", exact: true }).waitFor()
    const nativeCancellations = () =>
      f.requests.filter(
        (request) =>
          request.body &&
          typeof request.body === "object" &&
          "operation" in request.body &&
          request.body.operation === "cancel-source",
      )
    expect(nativeCancellations()).toHaveLength(0)
    expect(f.changed).toBe(0)
    expect(await recovered.getByRole("heading", { name: "Ready to move", exact: true }).isVisible()).toBe(true)
    expect(await recovered.getByRole("button", { name: "Release the source", exact: true }).count()).toBe(0)
    await recovered.getByRole("button", { name: "Confirm source cancellation", exact: true }).click()
    await f.page
      .getByRole("dialog", { name: "Confirm source cancellation", exact: true })
      .getByRole("button", { name: "Confirm source cancellation", exact: true })
      .click()
    await recovered.getByRole("heading", { name: "Move cancelled; source remains paused", exact: true }).waitFor()
    expect(nativeCancellations()).toHaveLength(1)
    expect(f.requests.filter((request) => request.path.endsWith("/cancel"))).toHaveLength(1)
    expect(f.changed).toBe(1)
    expect(f.errors).toEqual([])
  } finally {
    await f.page.close()
  }
}, 30_000)

test("the real Chinese catalog keeps desktop and narrow light and dark move plans readable", async () => {
  for (const variant of [
    { viewport: { width: 1100, height: 760 }, colorScheme: "light" as const, cloud: false },
    { viewport: { width: 375, height: 667 }, colorScheme: "light" as const, cloud: false },
    { viewport: { width: 375, height: 667 }, colorScheme: "dark" as const, cloud: true },
  ]) {
    const f = await open({ ...variant, locale: "zh-CN" })
    try {
      expect(await f.page.locator("html").getAttribute("lang")).toBe("zh-CN")
      expect(await f.dialog.locator('[data-slot="dialog-title"]').innerText()).toMatch(/[\u3400-\u9fff]/)
      await f.dialog.locator(".organization-handoff-actions").first().getByRole("button").nth(1).waitFor()
      await f.dialog.locator(".organization-handoff-actions").first().getByRole("button").first().click()
      await f.dialog.locator(".organization-handoff-field").first().getByRole("button").click()
      await f.page
        .getByRole("option", { name: variant.cloud ? "Hosted destination" : "Destination computer", exact: true })
        .click()
      await f.page.locator('[role="listbox"]').waitFor({ state: "hidden" })
      await f.dialog.locator('button[data-variant="primary"]').click()
      await f.dialog.locator('h3[aria-live="polite"]').waitFor()
      if (!variant.cloud) {
        const acceptance = f.dialog.locator('button[data-variant="primary"]')
        await acceptance.click()
        await acceptance.waitFor({ state: "detached" })
      }
      const sourcePreparation = f.dialog.locator(".organization-handoff-actions").getByRole("button").first()
      const sourceLabel = await sourcePreparation.innerText()
      await sourcePreparation.click()
      await f.dialog.getByRole("button", { name: sourceLabel, exact: true }).waitFor({ state: "detached" })
      await f.dialog.locator(".organization-handoff-actions").getByRole("button").first().click()
      await f.dialog.locator('.organization-handoff-actions button[data-variant="primary"]').waitFor()
      expect(await f.dialog.locator('h3[aria-live="polite"]').innerText()).toMatch(/[\u3400-\u9fff]/)
      expect(await f.dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(
        await f.dialog.locator(".organization-handoff-summary > div").evaluateAll((rows) =>
          rows.every((row) => {
            const range = document.createRange()
            range.selectNodeContents(row.querySelector("dt")!)
            return row.querySelector("dd")!.getBoundingClientRect().left - range.getBoundingClientRect().right >= 8
          }),
        ),
      ).toBe(true)
      const close = await f.dialog
        .locator('[data-slot="dialog-actions"] button, [data-slot="dialog-footer"] button')
        .last()
        .boundingBox()
      expect(close && close.y >= 0 && close.y + close.height <= variant.viewport.height).toBe(true)
      expect(f.errors).toEqual([])
      await capture(f.page, `handoff-zh-${variant.viewport.width}-${variant.colorScheme}.png`)
    } finally {
      await f.page.close()
    }
  }
}, 45_000)

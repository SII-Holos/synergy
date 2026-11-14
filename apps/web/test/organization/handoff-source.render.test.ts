import { createServer } from "node:http"
import { afterEach, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { setupSolidSourceDOM } from "../support/solid-source-dom"

await setupSolidSourceDOM()
const { I18nProvider } = await import("@lingui/solid")
const { OrganizationNativeCleanup } = await import("../../src/organization/handoff-native-cleanup")
const { OrganizationNativeDifference } = await import("../../src/organization/handoff-native")
const { OrganizationOnboarding } = await import("../../src/organization/onboarding")
const { organizationNativeCleanupHandle } = await import("../../src/organization/handoff-native-cleanup-state")
const summary = Handoff.Difference.parse({
  sourceSnapshotHash: "b".repeat(64),
  targetDigest: "c".repeat(64),
  diffHash: "d".repeat(64),
  mappingPlanRevision: 1,
  entries: 2,
  sourceEntries: 2,
  targetEntries: 2,
  mode: { source: 0o755, target: 0o755 },
})
const binding = Handoff.Binding.parse({
  schemaVersion: 1,
  orgID: "org",
  deploymentIncarnation: "inc",
  handoffID: "handoff",
  sessionID: "session",
  sourceRuntimeID: "source",
  targetRuntimeID: "target",
  fromEpoch: 7,
  toEpoch: 8,
  mappingPlanRevision: 1,
  shareGeneration: 2,
})
const view = Handoff.View.parse({
  ...binding,
  phase: "cancelled",
  targetAccepted: true,
  cancelRequested: true,
  manifestHash: "b".repeat(64),
  commandSeq: 1,
  missingRequirements: [],
  canCancel: false,
  canAccept: false,
  canContinue: false,
  currentDriver: "source",
  bindingEpoch: 7,
  initiator: "account",
  mappingHash: "c".repeat(64),
  workspaceDifference: summary,
  workspaceMapping: {
    kind: "organization-native",
    moveID: "move",
    source: { workspaceID: "cloud", generation: 1 },
    resource: { resourceID: "storage", workspaceID: "cloud", generation: 1, path: "project" },
    target: {
      kind: "existing",
      workspaceID: "native",
      generation: 1,
      expectedRevision: 1,
      projectRevision: "d".repeat(64),
    },
  },
})
const runtime = Runtime.MemberRegistrationRecord.parse({
  runtimeID: "target",
  orgID: "org",
  deploymentIncarnation: "inc",
  runtimeKind: "member",
  accountID: "account",
  deviceID: "destination-computer",
  publicKey: "a".repeat(64),
  state: "active",
  revision: 1,
  connectionEpoch: 1,
  createdAt: 0,
})
function result(requestID: string) {
  return Handoff.MachineResult.parse({
    handoffID: binding.handoffID,
    requestID,
    runtimeID: runtime.runtimeID,
    operation: "inspect-target",
    state: "idle",
    stage: "idle",
    revision: "e".repeat(64),
    requirements: [],
    facts: [],
  })
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
function mount(body: () => ReturnType<typeof createComponent>) {
  const root = document.createElement("div")
  document.body.append(root)
  const i18n = setupI18n({ locale: "en", messages: { en: {} } })
  const dispose = render(
    () =>
      createComponent(I18nProvider, {
        i18n,
        get children() {
          return body()
        },
      }),
    root,
  )
  let closed = false
  function close() {
    if (closed) return
    closed = true
    dispose()
    root.remove()
  }
  cleanups.push(close)
  return { root, close }
}
async function settled() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function button(root: HTMLElement, label: string) {
  const value = [...root.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)
  if (!value) throw new Error("The real source-rendered action is absent")
  return value
}

test("the actual cleanup control retains unknown until its exact original result and retires a late reply", async () => {
  const handle = organizationNativeCleanupHandle(view, runtime)
  if (!handle) throw new Error("The renderer fixture requires an original native destination handle")
  const pending = Promise.withResolvers<Handoff.MachineResult>()
  const original = handle
  const completeResult = (requestID: string) =>
    Handoff.MachineResult.parse({
      ...result(requestID),
      state: "complete",
      stage: "target-preview-released",
      facts: [
        {
          proof: {
            ...original.binding,
            purpose: "target-preview-released",
            manifestHash: original.manifestHash,
            diffHash: null,
            tombstonePersisted: true,
          },
          signature: "f".repeat(128),
        },
      ],
    })
  let lateRequestID: string | undefined
  let inspected = 0
  let completed = 0
  const failed: unknown[] = []
  const f = mount(() =>
    createComponent(OrganizationNativeCleanup, {
      handle,
      heading: true,
      disabled: false,
      current: () => true,
      async read(requestID) {
        inspected++
        if (inspected === 1) return result(requestID)
        return completeResult(requestID)
      },
      complete() {
        completed++
      },
      failed: (error) => {
        failed.push(error)
      },
    }),
  )
  expect(f.root.textContent).toContain("Destination cleanup is not confirmed")
  button(f.root, "Check destination cleanup").click()
  await settled()
  expect(inspected).toBe(1)
  expect(completed).toBe(0)
  expect(f.root.querySelector("[role=status]")?.textContent).toContain("not confirmed")
  button(f.root, "Check destination cleanup").click()
  await settled()
  expect(inspected).toBe(2)
  expect(completed).toBe(1)
  expect(f.root.querySelector("[role=status]")?.textContent).not.toContain("not confirmed")
  expect([...f.root.querySelectorAll("button")].some((node) => node.textContent === "Check destination cleanup")).toBe(
    false,
  )
  f.close()
  const held = mount(() =>
    createComponent(OrganizationNativeCleanup, {
      handle,
      heading: true,
      disabled: false,
      current: () => true,
      read: (requestID) => {
        lateRequestID = requestID
        return pending.promise
      },
      complete() {
        completed++
      },
      failed: (error) => {
        failed.push(error)
      },
    }),
  )
  button(held.root, "Check destination cleanup").click()
  held.close()
  if (!lateRequestID) throw new Error("The held cleanup did not dispatch its original inspection")
  pending.resolve(completeResult(lateRequestID))
  await pending.promise
  await settled()
  expect(completed).toBe(1)
  expect(failed).toEqual([])
  expect(held.root.isConnected).toBe(false)
})

test("the actual difference renderer requires a human review and returns the exact consent tuple", async () => {
  const accepted: Handoff.DifferenceConsent[] = []
  const failed: unknown[] = []
  let reads = 0
  const rows = ["one", "two"].map((path) => ({
    path,
    source: null,
    target: { path, kind: "file", size: 1, mode: 0o644, hash: "e".repeat(64) },
  }))
  const f = mount(() =>
    createComponent(OrganizationNativeDifference, {
      view,
      revision: 1,
      disabled: false,
      pending: false,
      consentAvailable: true,
      async read() {
        reads++
        return Handoff.MachineResult.parse({
          ...result("comparison"),
          workspaceDifference: summary,
          differencePage: { diffHash: summary.diffHash, items: rows },
        })
      },
      preview() {
        throw new Error("Loaded differences must not allocate a new preview")
      },
      accept: (value) => {
        accepted.push(value)
      },
      failed: (error) => {
        failed.push(error)
      },
    }),
  )
  await settled()
  expect(reads).toBe(1)
  expect(f.root.textContent).toContain("one")
  expect(f.root.textContent).toContain("two")
  const accept = [...f.root.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("destination versions"),
  )
  expect(accept).toBeDefined()
  expect(accept!.disabled).toBe(true)
  const checkbox = f.root.querySelector<HTMLInputElement>("input[type=checkbox]")
  expect(checkbox).not.toBeNull()
  checkbox!.click()
  await settled()
  expect(accept!.disabled).toBe(false)
  accept!.click()
  expect(accepted).toEqual([Handoff.DifferenceConsent.strip().parse(summary)])
  expect(failed).toEqual([])
})

test("the actual reset form holds its original SDK request and clears the password after confirmation", async () => {
  const received = Promise.withResolvers<Identity.ResetConsume>()
  const response = Promise.withResolvers<ReturnType<typeof Identity.Success.parse>>()
  const token = "1".repeat(64)
  const password = "synthetic reset password"
  let requests = 0
  const server = createServer((request, outgoing) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/org/v1/auth/reset") {
        received.reject(new Error("The reset SDK requested an unexpected route"))
        outgoing.writeHead(404).end()
        return
      }
      requests++
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const parsed = Identity.ResetConsume.parse(JSON.parse(Buffer.concat(chunks).toString()))
      received.resolve(parsed)
      const value = await response.promise
      outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value))
    })().catch(() => {
      received.reject(new Error("The reset SDK body did not satisfy its original schema"))
      outgoing.writeHead(400).end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The owned reset HTTP listener did not bind")
  const browser = window as unknown as { happyDOM: { setURL(url: string): void } }
  const previousURL = window.location.href
  let mounted: ReturnType<typeof mount> | undefined
  let observer: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    browser.happyDOM.setURL(`http://127.0.0.1:${address.port}/organization/reset`)
    const f = mount(() => createComponent(OrganizationOnboarding, { page: { kind: "reset", token } }))
    mounted = f
    expect(f.root.textContent).toContain("New password")
    expect(f.root.textContent).toContain("Use at least 12 characters")
    expect(f.root.querySelectorAll("input")).toHaveLength(1)
    const field = f.root.querySelector<HTMLInputElement>("input[type=password]")
    const form = f.root.querySelector("form")
    const fieldset = f.root.querySelector("fieldset")
    const submit = button(f.root, "Save password")
    if (!field || !form || !fieldset) throw new Error("The actual reset form did not render")
    field.value = password
    field.dispatchEvent(new Event("input", { bubbles: true }))
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    const sent = await Promise.race([
      received.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The actual reset SDK request did not arrive")), 1000)
      }),
    ])
    clearTimeout(timer)
    expect(sent.token).toBe(token)
    expect(sent.password).toBe(password)
    expect(requests).toBe(1)
    expect(fieldset.disabled).toBe(true)
    expect(submit.disabled).toBe(true)
    expect(submit.textContent?.trim()).toBe("Setting up…")
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settled()
    expect(requests).toBe(1)
    const completed = new Promise<void>((resolve, reject) => {
      const current = () =>
        f.root.querySelector("[role=status]")?.textContent?.includes("Your password has been changed")
      observer = new MutationObserver(() => {
        if (!current()) return
        clearTimeout(timer)
        observer?.disconnect()
        resolve()
      })
      observer.observe(f.root, { subtree: true, childList: true, characterData: true })
      timer = setTimeout(() => {
        observer?.disconnect()
        reject(new Error("The original reset confirmation did not render"))
      }, 1000)
      if (current()) {
        clearTimeout(timer)
        observer.disconnect()
        resolve()
      }
    })
    response.resolve(Identity.Success.parse({ ok: true }))
    await completed
    expect(f.root.querySelector("form")).toBeNull()
    expect(f.root.textContent).toContain("You're ready to go")
    expect(field.value).toBe("")
    expect(requests).toBe(1)
  } finally {
    clearTimeout(timer)
    observer?.disconnect()
    response.resolve(Identity.Success.parse({ ok: true }))
    mounted?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    browser.happyDOM.setURL(previousURL)
  }
})

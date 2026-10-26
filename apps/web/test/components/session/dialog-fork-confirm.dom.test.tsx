import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
let baseUrl: string

const componentPath = path.resolve(import.meta.dir, "../../../src/components/session/dialog-fork-confirm.tsx")

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".dialog-fork-confirm-fixture-"))
  const localeStubPath = path.join(fixtureDirectory, "locale-stub.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    // The real app locale provider pulls the full Lingui catalog chain; a
    // minimal stub keeps the fixture hermetic. Lingui core still performs ICU
    // interpolation on descriptor fallback messages, so the rendered copy
    // (including plural/select) is observable.
    Bun.write(
      localeStubPath,
      `
        import { setupI18n } from "@lingui/core"
        const i18n = setupI18n({ locale: "en", messages: {} })
        export const useLocale = () => ({ i18n, fmt: { time: (value: number) => String(value) } })
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, onMount } from "solid-js"
        import { render } from "solid-js/web"
        import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { DialogForkConfirm } from ${JSON.stringify(`/@fs/${componentPath}`)}
        import "@ericsanchezok/synergy-ui/styles"

        const params = new URLSearchParams(location.search)
        const completeHistory = params.get("complete") !== "false"
        const pendingConfirm = params.get("pending") === "true"
        const i18n = setupI18n({ locale: "en", messages: {} })

        const timeline = [
          { id: "u1", role: "user" },
          { id: "a1", role: "assistant" },
          { id: "u2", role: "user" },
          { id: "a2", role: "assistant" },
        ]

        function Harness() {
          const dialog = useDialog()
          let reads = 0
          onMount(() => {
            const id = dialog.push(() =>
              createComponent(DialogForkConfirm, {
                source: {
                  title: "Discuss architecture",
                  workspace: { id: params.get("main") ? "main" : "tree", type: params.get("main") ? "directory" : "git_worktree", path: "/project/tree", scopeID: "project" },
                },
                message: params.get("current") ? undefined : { id: "a2", time: { created: 1, completed: 2 } },
                allMessages: timeline,
                hasCompleteHistory: completeHistory,
                preview: "Reply text",
                loadDirectories: async () => {
                  if (params.get("loading")) await new Promise(() => {})
                  if (params.get("error") && reads++ === 0) throw new Error("Offline")
                  return {
                    version: 1, scopeID: "project", revision: 1, mainWorkspaceID: "main", additionalWorkspaceIDs: [],
                    folders: [{ workspaceID: "main", generation: 3, path: "/project", available: true, git: !params.get("nonGit") }],
                  }
                },
                onClose: () => dialog.close(id),
                onConfirm: pendingConfirm
                  ? () => new Promise<boolean>(() => {})
                  : async (workspace) => {
                    document.body.dataset.destination = JSON.stringify(workspace)
                    return true
                  },
              }),
            )
          })
          return null
        }

        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              get children() {
                return createComponent(DialogProvider, {
                  get children() {
                    return createComponent(Harness, {})
                  },
                })
              },
            }),
          document.querySelector("#root")!,
        )
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: {
        "@/context/locale": localeStubPath,
        "@": path.resolve(import.meta.dir, "../../../src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5211,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")
  baseUrl = url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("fork confirm dialog", () => {
  test("shows an exact copied summary for a complete window", async () => {
    await page.goto(baseUrl)
    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.count()).resolves.toBe(1)
    await expect(page.getByText("Copy 2 messages and 2 replies into a new session.").count()).resolves.toBe(1)
  })

  test("falls back to a generic summary when the window is incomplete", async () => {
    await page.goto(`${baseUrl}?complete=false`)
    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.count()).resolves.toBe(1)
    await expect(page.getByText("Copy the conversation into a new session.").count()).resolves.toBe(1)
  })

  test("close button is named and actions are reachable", async () => {
    await page.goto(baseUrl)
    const close = page.locator('[data-slot="dialog-close-button"]')
    await expect(close.count()).resolves.toBe(1)
    expect(await close.getAttribute("aria-label")).toBe("Close dialog")
    await expect(page.getByRole("button", { name: "Cancel" }).count()).resolves.toBe(1)
    await expect(page.getByRole("button", { name: "Fork session" }).count()).resolves.toBe(1)
  })

  test("cannot dismiss with Escape or backdrop click while the fork is pending", async () => {
    await page.goto(`${baseUrl}?pending=true`)
    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.count()).resolves.toBe(1)

    await page.getByRole("button", { name: "Fork session" }).click()
    await expect(page.getByText("Forking…").count()).resolves.toBe(1)

    await page.keyboard.press("Escape")
    await expect(dialog.count()).resolves.toBe(1)

    const overlay = page.locator('[data-component="dialog-overlay"]')
    await expect(overlay.count()).resolves.toBe(1)
    await overlay.dispatchEvent("pointerdown")
    await overlay.dispatchEvent("pointerup")
    await overlay.dispatchEvent("click")
    await expect(dialog.count()).resolves.toBe(1)
  })

  test("closes the dialog after a successful fork", async () => {
    await page.goto(baseUrl)
    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.count()).resolves.toBe(1)

    await page.getByRole("button", { name: "Fork session" }).click()
    await expect(dialog.count()).resolves.toBe(0)
    expect(await page.locator("body").getAttribute("data-destination")).toBe('{"mode":"current"}')
  })

  test("selects main explicitly instead of keeping the source worktree", async () => {
    await page.goto(baseUrl)
    await page.getByText("Main directory", { exact: true }).click()
    expect(await page.getByRole("radio", { name: "Main directory", exact: true }).isChecked()).toBe(true)
    await page.getByRole("button", { name: "Fork session", exact: true }).click()
    expect(await page.locator("body").getAttribute("data-destination")).toBe(
      '{"mode":"workspace","workspaceID":"main","workspaceGeneration":3}',
    )
    expect(await page.getByRole("dialog").count()).toBe(0)
  })

  test("stages new worktree choice and cancellation does not create anything", async () => {
    await page.goto(baseUrl)
    await page.getByText("New worktree", { exact: true }).click()
    expect(await page.locator("body").getAttribute("data-destination")).toBeNull()
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    expect(await page.locator("body").getAttribute("data-destination")).toBeNull()
    expect(await page.getByRole("dialog").count()).toBe(0)
  })

  test("the whole-conversation fork uses the same destination chooser", async () => {
    await page.goto(`${baseUrl}?current=true`)
    await page.getByRole("radio", { name: "Same worktree", exact: true }).focus()
    await page.keyboard.press("ArrowUp")
    expect(await page.getByRole("radio", { name: "New worktree", exact: true }).isChecked()).toBe(true)
    expect(
      await page.getByRole("dialog").getByText("Copy the conversation into a new session.", { exact: true }).count(),
    ).toBe(1)
    await page.getByRole("button", { name: "Fork session", exact: true }).click()
    expect(await page.locator("body").getAttribute("data-destination")).toBe(
      '{"mode":"create","sourceWorkspaceID":"main"}',
    )
  })

  test("non-Git main projects omit worktree choices and duplicate current location", async () => {
    await page.goto(`${baseUrl}?main=true&nonGit=true`)
    await page.getByRole("radio", { name: "Main directory", exact: true }).waitFor()
    expect(await page.getByRole("radio").count()).toBe(1)
    expect(await page.getByRole("radio", { name: "Main directory", exact: true }).isChecked()).toBe(true)
  })

  test("loading keeps cancel reachable and does not permit an implicit fallback", async () => {
    await page.goto(`${baseUrl}?loading=true`)
    expect(await page.getByRole("button", { name: "Fork session", exact: true }).isDisabled()).toBe(true)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    expect(await page.getByRole("dialog").count()).toBe(0)
  })

  test("location failure is visible and retry restores choices without submitting", async () => {
    await page.goto(`${baseUrl}?error=true`)
    await page.getByRole("alert").waitFor()
    expect(await page.getByRole("button", { name: "Fork session", exact: true }).isDisabled()).toBe(true)
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await page.getByRole("radio", { name: "Same worktree", exact: true }).waitFor()
    expect(await page.getByRole("button", { name: "Fork session", exact: true }).isEnabled()).toBe(true)
    expect(await page.locator("body").getAttribute("data-destination")).toBeNull()
  })
})

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

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".settings-dialog-dismiss-fixture-"))
  const componentPath = path.resolve(import.meta.dir, "../../../src/components/settings/settings-dialog-frame.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { createComponent, onMount } from "solid-js"
        import { render } from "solid-js/web"
        import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
        import { SettingsDialogFrame } from ${JSON.stringify(`/@fs/${componentPath}`)}

        const i18n = setupI18n({ locale: "en" })
        i18n.loadAndActivate({ locale: "en", messages: {} })

        function Harness() {
          const dialog = useDialog()
          onMount(() => {
            dialog.show(() =>
              createComponent(SettingsDialogFrame, {
                ariaLabel: "Settings",
                get children() {
                  return "Guarded close"
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
    server: {
      host: "127.0.0.1",
      port: 5204,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(url)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("Settings dialog dismissal", () => {
  test("does not bypass guarded close controls with Escape or backdrop interaction", async () => {
    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog.count()).resolves.toBe(1)

    await page.keyboard.press("Escape")
    await expect(dialog.count()).resolves.toBe(1)

    const overlay = page.locator('[data-component="dialog-overlay"]')
    await expect(overlay.count()).resolves.toBe(1)
    await overlay.dispatchEvent("pointerdown")
    await overlay.dispatchEvent("pointerup")
    await overlay.dispatchEvent("click")

    await expect(dialog.count()).resolves.toBe(1)
  })
})

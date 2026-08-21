import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

/**
 * Programmatically builds a minimal two-page PDF with one text line per page.
 * ASCII-only content keeps byte offsets equal to string lengths for the xref
 * table, and the Helvetica/Type1 font extracts as selectable text.
 */
function buildTwoPagePdf(): Uint8Array {
  const objects: string[] = []
  const offsets: number[] = []
  let content = "%PDF-1.4\n"
  const addObject = (body: string) => {
    offsets.push(content.length)
    objects.push(body)
    content += `${objects.length} 0 obj\n${body}\nendobj\n`
  }
  addObject("<< /Type /Catalog /Pages 2 0 R >>")
  addObject("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>")
  addObject(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
  )
  const stream1 = "BT /F1 24 Tf 72 720 Td (Hello Page One) Tj ET"
  addObject(`<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream`)
  addObject(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
  )
  const stream2 = "BT /F1 24 Tf 72 720 Td (Hello Page Two) Tj ET"
  addObject(`<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream`)
  addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const xrefOffset = content.length
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    content += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(content)
}

/** Resolve the current aria-pressed state of the "Fit width" toolbar button. */
function fitWidthPressed(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".attachment-pdf-toolbar button")].find(
      (candidate) => candidate.textContent?.trim() === "Fit width",
    )
    return button?.getAttribute("aria-pressed") ?? null
  })
}

async function waitForFitWidthState(page: Page, pressed: boolean): Promise<void> {
  await page.waitForFunction((expected) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".attachment-pdf-toolbar button")].find(
      (candidate) => candidate.textContent?.trim() === "Fit width",
    )
    return button?.getAttribute("aria-pressed") === (expected ? "true" : "false")
  }, pressed)
}

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".pdf-preview-fixture-"))
  const pdfPreviewPath = path.resolve(import.meta.dir, "../../../src/components/attachment-workbench/pdf-preview.tsx")
  const stylesPath = path.resolve(import.meta.dir, "../../../src/components/attachment-workbench/styles.css")
  const appSrc = path.resolve(import.meta.dir, "../../../src")

  await Promise.all([
    Bun.write(path.join(fixtureDirectory, "fixture.pdf"), buildTwoPagePdf()),
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      `<div id="root"></div><script type="module" src="/main.ts"></script>`,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { AttachmentPdfPreview } from ${JSON.stringify(`/@fs/${pdfPreviewPath}`)}
        import ${JSON.stringify(`/@fs/${stylesPath}`)}

        // The app layout root is select-none; the PDF container must opt back
        // into text selection on its own, exactly like the markdown preview.
        document.body.style.userSelect = "none"

        const i18n = setupI18n({ locale: "en" })
        async function main() {
          const response = await fetch("/fixture.pdf")
          const bytes = new Uint8Array(await response.arrayBuffer())
          render(
            () =>
              createComponent(I18nProvider, {
                i18n,
                children: () => createComponent(AttachmentPdfPreview, { bytes }),
              }),
            document.querySelector("#root"),
          )
        }
        void main()
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: {
        "@": appSrc,
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5205,
      strictPort: true,
      // The pdfjs worker resolves inside the workspace root's bun store
      // (node_modules/.bun/...), so allow the whole worktree, mirroring the
      // default workspace-root allow list of a real dev server.
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 }, colorScheme: "light" })
  await page.goto(url)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("AttachmentPdfPreview viewer integration", () => {
  test("renders a continuous scroll document with selectable text and a working fit-width toggle", async () => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text())
    })

    const fitButton = page.getByRole("button", { name: "Fit width" })
    const pageLabel = page.locator(".attachment-pdf-toolbar > span:not(.attachment-pdf-toolbar-spacer)")

    // 1. Both pages are announced once the document loads (page-position label).
    await page.waitForFunction(
      () => document.querySelector(".attachment-pdf-toolbar")?.textContent?.includes("2"),
      undefined,
      { timeout: 30000 },
    )
    await expect(pageLabel.textContent()).resolves.toBe("1 / 2")

    // 2. Fit-width starts pressed (the default view) and toggles off and on.
    await expect(fitWidthPressed(page)).resolves.toBe("true")
    await fitButton.click()
    await waitForFitWidthState(page, false)
    await fitButton.click()
    await waitForFitWidthState(page, true)

    // 3. Zooming clears the pressed state; fit-width restores it.
    await page.getByRole("button", { name: "Zoom in" }).click()
    await waitForFitWidthState(page, false)
    await fitButton.click()
    await waitForFitWidthState(page, true)

    if (pageErrors.length > 0) throw new Error(`Page errors: ${pageErrors.join(" | ")}`)

    // 4. The text layer is present and mouse-selection works inside a
    //    user-select:none ancestor chain (page one is visible at this point).
    const pages = page.locator(".pdfViewer .page")
    await pages.first().waitFor({ state: "attached", timeout: 30000 })
    const textSpan = page.locator(".pdfViewer .textLayer span").first()
    await textSpan.waitFor({ state: "attached", timeout: 30000 })
    await textSpan.click({ clickCount: 3 })
    await page.waitForFunction(() => (window.getSelection()?.toString() ?? "").includes("Hello"))

    // 5. Continuous scroll: scrolling to the bottom appends page two to the
    //    same scroll container instead of swapping a single canvas, and the
    //    page-position label follows the current page.
    const container = page.locator(".attachment-pdf-viewer-container")
    await container.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await pages.nth(1).waitFor({ state: "attached", timeout: 30000 })
    expect(await pages.count()).toBeGreaterThanOrEqual(2)
    await page.waitForFunction(() => document.querySelector(".attachment-pdf-toolbar")?.textContent?.includes("2 / 2"))

    // 6. The prev/next controls still jump between pages in scroll mode.
    await page.getByRole("button", { name: "Previous page" }).click()
    await page.waitForFunction(() => document.querySelector(".attachment-pdf-toolbar")?.textContent?.includes("1 / 2"))
    await page.getByRole("button", { name: "Next page" }).click()
    await page.waitForFunction(() => document.querySelector(".attachment-pdf-toolbar")?.textContent?.includes("2 / 2"))

    // 7. The vendor stylesheet must not leak its light-dark color-scheme onto
    //    the document root.
    const colorScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
    expect(colorScheme).toBe("light")
  }, 90000)
})

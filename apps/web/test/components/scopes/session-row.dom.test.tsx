import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let server: ViteDevServer
let fixtureDirectory: string
let fixtureUrl: string

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".session-row-fixture-"))
  const appSrc = path.resolve(import.meta.dir, "../../../src")
  const componentPath = path.join(appSrc, "components/scopes/session-row.tsx")

  const stubs = {
    "stub-locale.ts": `
      export function useLocale() {
        return {
          i18n: { _: (d: { id: string; message?: string }) => d.message ?? d.id },
          fmt: { relative: () => "now" },
        }
      }
    `,
    "stub-icon.tsx": `
      import type { ComponentProps } from "solid-js"
      export function Icon(props: { name: string; class?: string; size?: string }) {
        return <span data-icon={props.name} class={props.class} data-size={props.size} />
      }
    `,
    "stub-spinner.tsx": `
      export function Spinner(props: { class?: string }) {
        return <span data-component="spinner" class={props.class} />
      }
    `,
    "stub-semantic.ts": `
      export function getSemanticIcon(token: string) {
        return token
      }
    `,
    "stub-draft-badge.tsx": `
      export function SessionDraftBadge() {
        return null
      }
    `,
  }

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    ...Object.entries(stubs).map(([name, source]) => Bun.write(path.join(fixtureDirectory, name), source)),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { render } from "solid-js/web"
        import { SessionRow } from ${JSON.stringify(`/@fs/${componentPath}`)}

        const session = (id: string, over: Record<string, unknown> = {}) => ({
          id,
          title: id,
          scope: { id: "scp_1", type: "project", directory: "/repo" },
          time: { created: 1, updated: 2 },
          pinned: 0,
          ...over,
        })

        function Row(props: { id: string; session: any; rowOver?: Record<string, unknown> }) {
          return (
            <div data-row={props.id}>
              <SessionRow
                session={props.session}
                isActive={false}
                isWorking={false}
                hasPermission={false}
                hasError={false}
                hasNotification={false}
                notificationCount={0}
                onSelect={() => {}}
                onTogglePin={() => {}}
                onArchive={() => {}}
                onRename={() => {}}
                {...(props.rowOver ?? {})}
              />
            </div>
          )
        }

        render(
          () => (
            <>
              <Row
                id="ses_wt"
                session={session("ses_wt", { workspace: { type: "git_worktree", path: "/repo/wt1", scopeID: "scp_1" } })}
              />
              <Row id="ses_pin" session={session("ses_pin", { pinned: 123 })} />
              <Row id="ses_idle" session={session("ses_idle")} />
              <Row id="ses_busy" session={session("ses_busy")} rowOver={{ isWorking: true }} />
            </>
          ),
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
      alias: [
        { find: "@/context/locale", replacement: path.join(fixtureDirectory, "stub-locale.ts") },
        {
          find: "@/components/sidebar/session-draft-badge",
          replacement: path.join(fixtureDirectory, "stub-draft-badge.tsx"),
        },
        { find: "@ericsanchezok/synergy-ui/icon", replacement: path.join(fixtureDirectory, "stub-icon.tsx") },
        { find: "@ericsanchezok/synergy-ui/spinner", replacement: path.join(fixtureDirectory, "stub-spinner.tsx") },
        {
          find: "@ericsanchezok/synergy-ui/semantic-icon",
          replacement: path.join(fixtureDirectory, "stub-semantic.ts"),
        },
        { find: "@/", replacement: `${appSrc}/` },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5224,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  fixtureUrl = server.resolvedUrls?.local[0] ?? ""
  if (!fixtureUrl) throw new Error("Expected Vite test server URL")
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

async function withFixture(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  try {
    await page.goto(fixtureUrl)
    await run(page)
  } finally {
    await page.close()
  }
}

describe("mobile project session rows", () => {
  test("renders the worktree glyph only for idle git-worktree sessions", async () => {
    await withFixture(async (page) => {
      const worktreeRow = page.locator('[data-row="ses_wt"]')
      await expect(worktreeRow.locator('[data-icon="workspace.worktree"].text-icon-weak-base').count()).resolves.toBe(1)
      await expect(worktreeRow.locator('[data-icon="action.pin"]').count()).resolves.toBe(0)
      await expect(worktreeRow.locator(".sr-only", { hasText: "Worktree session" }).count()).resolves.toBe(1)

      const idleRow = page.locator('[data-row="ses_idle"]')
      await expect(idleRow.locator('[data-icon="workspace.worktree"]').count()).resolves.toBe(0)
      await expect(idleRow.locator('[data-icon="action.pin"]').count()).resolves.toBe(0)
      await expect(idleRow.locator(".sr-only", { hasText: "Worktree session" }).count()).resolves.toBe(0)
    })
  })

  test("keeps the pin glyph for idle pinned sessions and the spinner for busy ones", async () => {
    await withFixture(async (page) => {
      const pinnedRow = page.locator('[data-row="ses_pin"]')
      await expect(pinnedRow.locator('[data-icon="action.pin"]').count()).resolves.toBe(1)
      await expect(pinnedRow.locator('[data-icon="workspace.worktree"]').count()).resolves.toBe(0)

      const busyRow = page.locator('[data-row="ses_busy"]')
      await expect(busyRow.locator('[data-component="spinner"]').count()).resolves.toBe(1)
      await expect(busyRow.locator('[data-icon="workspace.worktree"]').count()).resolves.toBe(0)
    })
  })
})

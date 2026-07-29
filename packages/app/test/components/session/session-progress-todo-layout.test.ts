import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"

const css = await readFile(
  new URL("../../../src/components/session/session-progress-island.css", import.meta.url),
  "utf8",
)
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

describe("session progress todo layout", () => {
  test("keeps expanded todo content scrollable inside the island", async () => {
    const page = await browser.newPage({ viewport: { width: 760, height: 600 } })
    try {
      await page.setContent(`
        <style>
          *, ::before, ::after { box-sizing: border-box; }
          ${css}
          .session-progress-island-panel {
            position: static;
            width: 640px;
            height: 220px;
            opacity: 1;
            pointer-events: auto;
            transform: none;
          }
          .todo-summary { flex: 0 0 24px; }
          .todo-row { flex: 0 0 36px; }
          .todo-expanded { flex: 0 0 180px; }
        </style>
        <div class="session-progress-island-panel">
          <div class="session-progress-island-panel-topline">Current work</div>
          <div class="session-progress-island-body">
            <div class="session-progress-todo">
              <div class="todo-summary">1 active · 3 pending</div>
              <div class="session-progress-todo-list">
                <div class="todo-row">Inspect the layout owner</div>
                <div class="todo-row">Expand the long todo</div>
                <div class="todo-expanded">${"Expanded task details ".repeat(24)}</div>
                <div class="todo-row" data-last-todo>Verify the final todo remains reachable</div>
              </div>
            </div>
          </div>
        </div>
      `)

      const beforeScroll = await page.locator(".session-progress-todo-list").evaluate((list) => ({
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
      }))
      expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight)

      const afterScroll = await page.locator(".session-progress-todo-list").evaluate((list) => {
        list.scrollTop = list.scrollHeight
        const viewport = list.getBoundingClientRect()
        const lastTodo = document.querySelector<HTMLElement>("[data-last-todo]")!.getBoundingClientRect()
        return {
          scrollTop: list.scrollTop,
          lastTodoTop: lastTodo.top,
          lastTodoBottom: lastTodo.bottom,
          viewportTop: viewport.top,
          viewportBottom: viewport.bottom,
        }
      })
      expect(afterScroll.scrollTop).toBeGreaterThan(0)
      expect(afterScroll.lastTodoTop).toBeGreaterThanOrEqual(afterScroll.viewportTop)
      expect(afterScroll.lastTodoBottom).toBeLessThanOrEqual(afterScroll.viewportBottom + 1)
    } finally {
      await page.close()
    }
  })
})

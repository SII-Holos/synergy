import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

let dom: JSDOM

beforeAll(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>")
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  globalThis.document = dom.window.document
  globalThis.Node = dom.window.Node
  globalThis.MutationObserver = dom.window.MutationObserver
})

afterAll(() => dom.window.close())

for (const entry of ["web.js", "dev.js", "web.cjs", "dev.cjs"])
  describe(`Solid ordered rows (${entry})`, () => {
    const renderer = () =>
      import(pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("solid-js/web"))), entry)).href) as Promise<
        typeof import("solid-js/web")
      >
    const fixture = async (initial: number[]) => {
      const { render, insert } = await renderer()
      const { createSignal } = (await import(
        pathToFileURL(
          join(
            dirname(fileURLToPath(import.meta.resolve("solid-js"))),
            entry.endsWith("cjs") ? "solid.cjs" : "solid.js",
          ),
        ).href
      )) as typeof import("solid-js")
      const mount = document.createElement("div")
      const host = document.createElement("div")
      document.body.append(mount)
      const rows = Array.from({ length: 50 }, (_, index) => {
        const row = document.createElement("div")
        row.dataset.row = String(index)
        const link = document.createElement("a")
        link.href = `https://example.test/${index}`
        link.textContent = `Reading point ${index}`
        row.append(link)
        return row
      })
      const [visible, setVisible] = createSignal(initial.map((index) => rows[index]))
      const dispose = render(() => {
        insert(host, visible)
        return host
      }, mount)
      return {
        host,
        rows,
        show: (indices: number[]) => setVisible(indices.map((index) => rows[index])),
        order: () => [...host.children].map((row) => Number((row as HTMLElement).dataset.row)),
        dispose: () => {
          dispose()
          mount.remove()
        },
      }
    }

    test("a retained focused row stays mounted when a paged range reverses direction", async () => {
      const view = await fixture([22, 23, 24, 25, 26, 27, 28, 30])
      try {
        const link = view.rows[30].firstElementChild as HTMLAnchorElement
        link.focus()
        expect(document.activeElement === link).toBe(true)
        view.show([26, 27, 28, 29, 30, 31, 32])
        expect(view.order()).toEqual([26, 27, 28, 29, 30, 31, 32])
        expect(document.activeElement === link).toBe(true)
      } finally {
        view.dispose()
      }
    })

    test("retained selected text survives admitting a disjoint range", async () => {
      const view = await fixture([33, 34, 35, 36, 37, 38, 39, 40])
      try {
        const text = view.rows[33].firstElementChild!.firstChild!
        const range = document.createRange()
        range.setStart(text, 2)
        range.setEnd(text, 11)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        const selected = selection.toString()
        view.show([...Array.from({ length: 16 }, (_, index) => index + 5), 33])
        expect(selection.toString()).toBe(selected)
        expect(selection.anchorNode === text).toBe(true)
        expect(selection.focusNode === text).toBe(true)
      } finally {
        document.getSelection()?.removeAllRanges()
        view.dispose()
      }
    })

    test("ordered admission and removal never detach shared rows and keep exact DOM order", async () => {
      const view = await fixture([0, 2, 4, 6, 8])
      const observer = new MutationObserver(() => {})
      observer.observe(view.host, { childList: true })
      try {
        let previous = [0, 2, 4, 6, 8]
        for (const next of [[1, 3, 4, 5, 9], [4], [0, 1, 4, 6], [], [2, 4], [1, 2, 3, 4, 5]]) {
          const retained = new Set(previous.filter((index) => next.includes(index)).map((index) => view.rows[index]))
          view.show(next)
          const removed = observer.takeRecords().flatMap((record) => [...record.removedNodes])
          expect(removed.some((node) => retained.has(node as HTMLDivElement))).toBe(false)
          expect(view.order()).toEqual(next)
          previous = next
        }
      } finally {
        observer.disconnect()
        view.dispose()
      }
    })

    test("true permutations preserve identities and exact DOM order", async () => {
      const view = await fixture([0, 1, 2, 3, 4])
      const permutations = (values: number[]): number[][] =>
        values.length
          ? values.flatMap((value) =>
              permutations(values.filter((item) => item !== value)).map((rest) => [value, ...rest]),
            )
          : [[]]
      try {
        for (const next of permutations([0, 1, 2, 3, 4])) {
          view.show(next)
          expect(view.order()).toEqual(next)
          expect([...view.host.children].every((node, index) => node === view.rows[next[index]])).toBe(true)
        }
      } finally {
        view.dispose()
      }
    })
  })

import { afterAll, afterEach, expect, test } from "bun:test"
import { createComponent, createSignal, type Accessor } from "solid-js"
import { render } from "solid-js/web"
import { setupSolidDOM } from "../support/solid-dom"

const closeDOM = await setupSolidDOM()
afterAll(closeDOM)
const { ViewActivityProvider, useViewActivity } = await import("../../src/context/view-activity")
const disposers: Array<() => void> = []

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

test("unowned controls stay active and nested owners require both activity signals", () => {
  expect(useViewActivity()()).toBe(true)
  const [parentActive, setParentActive] = createSignal(true)
  const [childActive, setChildActive] = createSignal(true)
  let active: Accessor<boolean> | undefined
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    render(
      () =>
        createComponent(ViewActivityProvider, {
          active: parentActive,
          get children() {
            return createComponent(ViewActivityProvider, {
              active: childActive,
              get children() {
                active = useViewActivity()
                return null
              },
            })
          },
        }),
      host,
    ),
  )
  expect(active?.()).toBe(true)
  setParentActive(false)
  expect(active?.()).toBe(false)
  setChildActive(false)
  setParentActive(true)
  expect(active?.()).toBe(false)
  setChildActive(true)
  expect(active?.()).toBe(true)
})

test("a disposed owner's captured activity stays false for delayed callbacks", () => {
  const [requested, setRequested] = createSignal(true)
  let active: Accessor<boolean> | undefined
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(ViewActivityProvider, {
        active: requested,
        get children() {
          active = useViewActivity()
          return null
        },
      }),
    host,
  )
  disposers.push(dispose)
  expect(active?.()).toBe(true)
  dispose()
  expect(active?.()).toBe(false)
  setRequested(false)
  setRequested(true)
  expect(active?.()).toBe(false)
})

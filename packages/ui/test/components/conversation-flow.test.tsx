import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { createComponent, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { setupSolidDOM } from "../support/solid-dom"

const closeDOM = await setupSolidDOM()
afterAll(closeDOM)
const { ConversationFlowProvider, useConversationFlow, useConversationLayoutCapture } = await import(
  "../../src/components/conversation-flow"
)
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
})

function mount(component: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(component, host)
  disposers.push(dispose)
  return { host, dispose }
}

function consumer(label: string, fallback: () => void) {
  const contained = useConversationFlow()
  const capture = useConversationLayoutCapture()
  if (!contained) fallback()
  const button = document.createElement("button")
  button.textContent = label
  button.dataset.flow = String(contained)
  button.dataset.capture = String(!!capture)
  button.addEventListener("click", () => {
    const commit = capture?.()
    commit?.()
  })
  return button
}

function button(host: Element, label: string) {
  const value = [...host.querySelectorAll("button")].find((node) => node.textContent === label)
  expect(value).toBeDefined()
  return value!
}

test("descendants share one parent capture and do not need a fallback layout owner", () => {
  const commits = mock(() => {})
  const capture = mock(() => commits)
  const fallback = mock(() => {})
  const observed: Array<ReturnType<typeof useConversationLayoutCapture>> = []
  const { host } = mount(() =>
    createComponent(ConversationFlowProvider, {
      captureLayout: capture,
      get children() {
        return ["reasoning", "activity"].map((label) => {
          observed.push(useConversationLayoutCapture())
          return consumer(label, fallback)
        })
      },
    }),
  )

  expect(observed).toEqual([capture, capture])
  expect(fallback).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
  expect(host.children).toHaveLength(2)
  for (const label of ["reasoning", "activity"]) {
    const control = button(host, label)
    expect(control.dataset.flow).toBe("true")
    control.click()
  }
  expect(capture).toHaveBeenCalledTimes(2)
  expect(commits).toHaveBeenCalledTimes(2)
})

test("standalone consumers expose no shared capture and can own their fallback", () => {
  const fallback = mock(() => {})
  const { host } = mount(() => consumer("standalone", fallback))
  const control = button(host, "standalone")

  expect(control.dataset.flow).toBe("false")
  expect(control.dataset.capture).toBe("false")
  expect(fallback).toHaveBeenCalledTimes(1)
  expect(() => control.click()).not.toThrow()
})

test("a provider without capture still marks its descendants as contained without creating another owner", () => {
  const fallback = mock(() => {})
  const { host } = mount(() =>
    createComponent(ConversationFlowProvider, {
      get children() {
        return consumer("contained", fallback)
      },
    }),
  )
  const control = button(host, "contained")

  expect(control.dataset.flow).toBe("true")
  expect(control.dataset.capture).toBe("false")
  expect(fallback).not.toHaveBeenCalled()
  expect(() => control.click()).not.toThrow()
})

test("the nearest provider owns capture while nested and sibling consumers remain isolated", () => {
  const outerCommit = mock(() => {})
  const innerCommit = mock(() => {})
  const outerCapture = mock(() => outerCommit)
  const innerCapture = mock(() => innerCommit)
  const fallback = mock(() => {})
  const { host } = mount(() => [
    createComponent(ConversationFlowProvider, {
      captureLayout: outerCapture,
      get children() {
        return [
          consumer("outer-before", fallback),
          createComponent(ConversationFlowProvider, {
            captureLayout: innerCapture,
            get children() {
              return consumer("inner", fallback)
            },
          }),
          consumer("outer-after", fallback),
        ]
      },
    }),
    consumer("outside", fallback),
  ])

  button(host, "inner").click()
  expect(innerCapture).toHaveBeenCalledTimes(1)
  expect(innerCommit).toHaveBeenCalledTimes(1)
  expect(outerCapture).not.toHaveBeenCalled()
  button(host, "outer-before").click()
  button(host, "outer-after").click()
  expect(outerCapture).toHaveBeenCalledTimes(2)
  expect(outerCommit).toHaveBeenCalledTimes(2)
  expect(button(host, "outside").dataset.flow).toBe("false")
  expect(button(host, "outside").dataset.capture).toBe("false")
  expect(fallback).toHaveBeenCalledTimes(1)
})

test("unmounting a conversation does not leak its capture into a new standalone consumer", () => {
  const commits = mock(() => {})
  const capture = mock(() => commits)
  const fallback = mock(() => {})
  const view = mount(() =>
    createComponent(ConversationFlowProvider, {
      captureLayout: capture,
      get children() {
        return consumer("previous", fallback)
      },
    }),
  )
  view.dispose()
  expect(view.host.childElementCount).toBe(0)

  const next = mount(() => consumer("next", fallback))
  const control = button(next.host, "next")
  expect(control.dataset.flow).toBe("false")
  expect(control.dataset.capture).toBe("false")
  control.click()
  expect(fallback).toHaveBeenCalledTimes(1)
  expect(capture).not.toHaveBeenCalled()
  expect(commits).not.toHaveBeenCalled()
})

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createComponent, render } from "solid-js/web"
import type { Part as PartType, UserMessage } from "@ericsanchezok/synergy-sdk/client"

GlobalRegistrator.register()

let dispose: (() => void) | undefined

mock.module("../context", () => ({
  useData: () => ({
    navigateToSession: () => {},
  }),
}))

mock.module("./icon", () => ({
  Icon: (props: { name: string }) => {
    const el = document.createElement("span")
    el.dataset.component = "icon"
    el.dataset.name = props.name
    return el
  },
}))

mock.module("./message-part", () => ({
  Message: (props: { userVariant?: string; parts: PartType[] }) => {
    const el = document.createElement("div")
    el.dataset.component = "user-message"
    el.dataset.variant = props.userVariant ?? "default"
    el.textContent = props.parts
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n")
    return el
  },
}))

mock.module("./special-user-message.css", () => ({}))

const { getSpecialUserMessageRenderer } = await import("./special-user-message")

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function userMessage(metadata: Record<string, unknown>): UserMessage {
  return {
    id: "message_user",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    metadata,
  } as UserMessage
}

function textPart(text: string): PartType {
  return {
    id: "part_text",
    sessionID: "session",
    messageID: "message_user",
    type: "text",
    text,
  } as PartType
}

function renderSpecial(message: UserMessage, parts: PartType[] = []) {
  const Component = getSpecialUserMessageRenderer(message)
  if (!Component) throw new Error("expected special user message renderer")

  const root = document.createElement("div")
  document.body.appendChild(root)
  dispose = render(() => createComponent(Component, { message, parts }), root)
  return root
}

describe("special user messages", () => {
  test("renders Plan Mode requests as right-side user bubbles", async () => {
    const root = renderSpecial(userMessage({ planModeRequest: true }), [textPart("Create a Blueprint")])
    await Promise.resolve()

    const wrapper = root.querySelector('[data-component="special-user-message"]')
    const user = root.querySelector('[data-component="user-message"]')

    expect(wrapper?.getAttribute("data-layout")).toBe("user-bubble")
    expect(root.querySelector('[data-slot="special-message-badge"]')?.textContent).toBe("Plan mode")
    expect(user?.getAttribute("data-variant")).toBe("turn-bubble")
    expect(user?.textContent).toContain("Create a Blueprint")
  })

  test("renders Blueprint control messages as event cards", async () => {
    const cases = [
      ["blueprint_loop_start", "Started execution"],
      ["blueprint_loop_continuation", "Continued from idle"],
      ["blueprint_loop_restart", "Changes requested"],
    ] as const

    for (const [source, heading] of cases) {
      const root = renderSpecial(
        userMessage({
          source,
          loopID: "loop_123",
          noteID: "note_123",
          sourceSessionID: "session_source",
        }),
      )
      await Promise.resolve()

      const wrapper = root.querySelector('[data-component="special-user-message"]')

      expect(wrapper?.getAttribute("data-layout")).toBe("event-card")
      expect(root.querySelector('[data-slot="special-message-heading"]')?.textContent).toBe(heading)
      expect(root.textContent).toContain("Loop loop_123")
      expect(root.textContent).toContain("Note note_123")
      expect(root.textContent).toContain("Source session")

      dispose?.()
      dispose = undefined
      document.body.replaceChildren()
    }
  })

  test("keeps Blueprint restart details collapsed until opened", async () => {
    const root = renderSpecial(
      userMessage({
        source: "blueprint_loop_restart",
        reason: "Tests failed",
        completed: "Implemented UI",
        remaining: "Fix tests",
        instructions: "Run the suite again",
      }),
    )
    await Promise.resolve()

    const trigger = root.querySelector<HTMLButtonElement>('[data-slot="special-message-details-trigger"]')

    expect(trigger?.getAttribute("aria-expanded")).toBe("false")
    expect(root.textContent).not.toContain("Reason")
    expect(root.textContent).not.toContain("Tests failed")

    trigger?.click()
    await Promise.resolve()

    expect(trigger?.getAttribute("aria-expanded")).toBe("true")
    expect(root.textContent).toContain("Reason")
    expect(root.textContent).toContain("Tests failed")
    expect(root.textContent).toContain("Completed")
    expect(root.textContent).toContain("Remaining")
    expect(root.textContent).toContain("Next actions")
  })
})

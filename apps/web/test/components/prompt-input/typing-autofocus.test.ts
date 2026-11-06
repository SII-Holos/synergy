import { afterEach, expect, test } from "bun:test"
import { handleComposerTypingAutofocus } from "../../../src/components/prompt-input/typing-autofocus"

afterEach(() => document.body.replaceChildren())

function composer() {
  const input = document.createElement("div")
  input.contentEditable = "true"
  input.tabIndex = 0
  document.body.append(input)
  return input
}

test("typing in the reading area focuses the Composer, while shortcuts and modal input do not", () => {
  const input = composer()
  for (const event of [
    new KeyboardEvent("keydown", { key: "Escape" }),
    new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
    new KeyboardEvent("keydown", { key: "k", metaKey: true }),
  ]) {
    handleComposerTypingAutofocus(event, input, false)
    expect(document.activeElement).not.toBe(input)
  }
  handleComposerTypingAutofocus(new KeyboardEvent("keydown", { key: "a" }), input, true)
  expect(document.activeElement).not.toBe(input)
  const prevented = new KeyboardEvent("keydown", { key: "a", cancelable: true })
  prevented.preventDefault()
  handleComposerTypingAutofocus(prevented, input, false)
  expect(document.activeElement).not.toBe(input)
  handleComposerTypingAutofocus(new KeyboardEvent("keydown", { key: "a" }), input, false)
  expect(document.activeElement).toBe(input)
})

for (const markup of [
  "<button>Expand</button>",
  '<a href="#item">Open</a>',
  '<div role="tab" tabindex="0">Tab</div>',
  "<input>",
  "<textarea></textarea>",
  "<select><option>A</option></select>",
  '<div role="textbox" tabindex="0"></div>',
  '<div data-prevent-autofocus tabindex="0"></div>',
]) {
  test(`focused controls retain their typing and Space keys: ${markup}`, () => {
    const input = composer()
    const wrapper = document.createElement("div")
    wrapper.innerHTML = markup
    document.body.append(wrapper)
    const control = wrapper.firstElementChild as HTMLElement
    control.focus()
    for (const key of [" ", "a"]) {
      handleComposerTypingAutofocus(new KeyboardEvent("keydown", { key }), input, false)
      expect(document.activeElement).toBe(control)
    }
  })
}

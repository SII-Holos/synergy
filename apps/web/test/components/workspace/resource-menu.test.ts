import { afterEach, beforeEach, expect, test } from "bun:test"
import { resourceMenuKeyDown } from "../../../src/components/workspace/resource-menu"

let menu: HTMLDivElement
let outside: HTMLButtonElement

beforeEach(() => {
  menu = document.createElement("div")
  menu.setAttribute("role", "menu")
  menu.innerHTML = `
    <button role="menuitem">First</button>
    <button role="menuitem" disabled>Unavailable</button>
    <button role="menuitemradio" aria-disabled="true">Disabled choice</button>
    <button role="menuitemradio" aria-disabled="false">Second</button>
    <button role="menuitemcheckbox">Last</button>
  `
  menu.addEventListener("keydown", (event) => resourceMenuKeyDown(event as Parameters<typeof resourceMenuKeyDown>[0]))
  outside = document.createElement("button")
  document.body.append(outside, menu)
  outside.focus()
})

afterEach(() => {
  menu.remove()
  outside.remove()
})

function press(key: string, target: HTMLElement = menu) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function focused() {
  return document.activeElement?.textContent
}

test("arrow navigation wraps through enabled menu items of every supported role", () => {
  for (const label of ["First", "Second", "Last", "First"]) {
    expect(press("ArrowDown").defaultPrevented).toBe(true)
    expect(focused()).toBe(label)
  }
  for (const label of ["Last", "Second", "First", "Last"]) {
    expect(press("ArrowUp").defaultPrevented).toBe(true)
    expect(focused()).toBe(label)
  }
})

test("ArrowUp enters an unfocused menu at its last enabled item", () => {
  expect(press("ArrowUp").defaultPrevented).toBe(true)
  expect(focused()).toBe("Last")
})

test("Home and End select the first and last enabled items", () => {
  expect(press("End").defaultPrevented).toBe(true)
  expect(focused()).toBe("Last")
  expect(press("Home").defaultPrevented).toBe(true)
  expect(focused()).toBe("First")
})

test("navigation keys remain available to inputs, textareas and editable descendants", () => {
  for (const tag of ["input", "textarea", "div"]) {
    const editor = document.createElement(tag)
    const target = tag === "div" ? document.createElement("span") : editor
    if (tag === "div") {
      editor.setAttribute("contenteditable", "true")
      editor.append(target)
    }
    menu.append(editor)
    editor.focus()
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(press(key, target).defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(editor)
    }
    editor.remove()
  }
})

test("empty menus and unrelated keys neither capture the event nor move focus", () => {
  for (const key of ["Enter", "Escape", "Tab", "a"]) {
    expect(press(key).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(outside)
  }
  menu.replaceChildren()
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    expect(press(key).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(outside)
  }
})

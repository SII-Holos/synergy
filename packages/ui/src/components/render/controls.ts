import type { Control, RenderRuntime, ViewState } from "./protocol"

export function installRenderControls(
  api: RenderRuntime,
  host: {
    labels: Record<string, string>
    getView(): ViewState
    saveView(): void
    report(error: unknown): void
    version: string
    offline: boolean
  },
) {
  const L = host.labels
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const element = document.createElement(tag)
    if (text) element.textContent = text
    return element
  }
  function button(text: string, action: () => void) {
    const element = make("button", text)
    element.type = "button"
    element.addEventListener("click", action)
    return element
  }
  function mount(element: HTMLElement) {
    if (document.body) document.body.append(element)
    else document.addEventListener("DOMContentLoaded", () => document.body.append(element), { once: true })
  }
  let controlsRoot: HTMLElement | undefined
  let variantRoot: HTMLElement | undefined
  let variants: Array<{ id: string; label: string; element: HTMLElement }> = []
  let controlItems: Control[] = []
  let change: ((values: Record<string, Control["value"]>) => void) | undefined
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
  function key(item: Control) {
    return `${item.variant ?? "*"}:${item.id}`
  }
  function values() {
    return Object.fromEntries(
      controlItems
        .filter((item) => !item.variant || item.variant === host.getView().variant)
        .map((item) => [item.id, host.getView().controls[key(item)] ?? item.value]),
    )
  }
  function sync(notify = true) {
    const view = host.getView()
    for (const item of controlItems) {
      const input = inputs.get(key(item))
      if (!input) continue
      const value = view.controls[key(item)] ?? item.value
      if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = !!value
      else input.value = String(value)
      const row = input.closest<HTMLElement>("[data-render-control]")!
      row.hidden = !!item.variant && item.variant !== view.variant
      const output = row.querySelector("output")
      if (output) output.textContent = String(value)
    }
    if (notify) change?.(values())
  }
  api.controls = (items, onChange) => {
    const groups = new Map<string, number>()
    const identities = new Set<string>()
    if (items.length > 96) throw new Error(L.tooMany)
    for (const item of items) {
      const count = (groups.get(item.group ?? "") ?? 0) + 1
      groups.set(item.group ?? "", count)
      if (
        count > 12 ||
        identities.has(key(item)) ||
        !item.id ||
        item.id.length > 120 ||
        !item.label ||
        item.label.length > 160
      )
        throw new Error(L.invalidControls)
      identities.add(key(item))
      if (!["number", "color", "boolean", "select"].includes(item.type)) throw new Error(L.invalidControls)
      if (
        item.type === "number" &&
        (![item.value, item.min ?? 0, item.max ?? 100, item.step ?? 1].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ) ||
          (item.min ?? 0) >= (item.max ?? 100) ||
          (item.step ?? 1) <= 0)
      )
        throw new Error(L.invalidControls)
      if (item.type === "color" && !/^#[0-9a-f]{6}$/i.test(String(item.value))) throw new Error(L.invalidControls)
      if (item.type === "boolean" && typeof item.value !== "boolean") throw new Error(L.invalidControls)
      if (
        item.type === "select" &&
        (!item.options?.length ||
          item.options.length > 12 ||
          item.options.some((option) => typeof option !== "string" || option.length > 160) ||
          !item.options.includes(String(item.value)))
      )
        throw new Error(L.invalidControls)
    }
    controlsRoot?.remove()
    inputs.clear()
    controlItems = items
    change = onChange
    const root = make("section")
    root.dataset.renderControls = ""
    root.setAttribute("aria-label", L.parameters)
    const containers = new Map<string, HTMLElement>()
    for (const item of items) {
      const group = item.group ?? L.parameters
      if (!containers.has(group)) {
        const fieldset = make("fieldset")
        fieldset.append(make("legend", group))
        root.append(fieldset)
        containers.set(group, fieldset)
      }
      const row = make("label")
      row.dataset.renderControl = ""
      row.append(make("span", item.label))
      const input = item.type === "select" ? make("select") : make("input")
      input.setAttribute("aria-label", item.label)
      if (input instanceof HTMLSelectElement) {
        for (const option of item.options!) input.append(make("option", option))
      } else {
        input.type = item.type === "number" ? "range" : item.type === "boolean" ? "checkbox" : "color"
        if (item.type === "number") {
          input.min = String(item.min ?? 0)
          input.max = String(item.max ?? 100)
          input.step = String(item.step ?? 1)
        }
      }
      input.addEventListener("input", () => {
        const value =
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? input.checked
            : item.type === "number"
              ? Number(input.value)
              : input.value
        host.getView().controls[key(item)] = value
        sync()
        host.saveView()
      })
      inputs.set(key(item), input)
      row.append(input)
      if (item.type === "number") row.append(make("output"))
      containers.get(group)!.append(row)
    }
    const actions = make("div")
    actions.dataset.renderActions = ""
    const reset = button(L.reset, () => {
      for (const item of controlItems)
        if (!item.variant || item.variant === host.getView().variant) delete host.getView().controls[key(item)]
      sync()
      host.saveView()
    })
    const original = button(L.original, () => {})
    const previewOriginal = (active: boolean) => {
      if (!change) return
      change(
        active
          ? Object.fromEntries(
              controlItems
                .filter((item) => !item.variant || item.variant === host.getView().variant)
                .map((item) => [item.id, item.value]),
            )
          : values(),
      )
    }
    original.addEventListener("pointerdown", () => previewOriginal(true))
    for (const event of ["pointerup", "pointerleave", "pointercancel", "blur"])
      original.addEventListener(event, () => previewOriginal(false))
    original.addEventListener("keydown", (event) => {
      if ([" ", "Enter"].includes(event.key)) {
        event.preventDefault()
        previewOriginal(true)
      }
    })
    original.addEventListener("keyup", () => previewOriginal(false))
    const submit = button(L.review, () => {
      const before = Object.fromEntries(
        controlItems
          .filter((item) => !item.variant || item.variant === host.getView().variant)
          .map((item) => [item.id, item.value]),
      )
      api
        .requestFollowUp(
          `${L.changes}\n${JSON.stringify({ version: host.version, variant: host.getView().variant, before, after: values() })}`,
        )
        .catch(host.report)
    })
    submit.disabled = host.offline
    actions.append(reset, original, submit)
    root.append(actions)
    controlsRoot = root
    mount(root)
    sync()
  }
  function selectVariant(id: string, save = true) {
    if (!variants.some((item) => item.id === id)) return
    host.getView().variant = id
    for (const item of variants) {
      item.element.hidden = item.id !== id
      item.element.inert = item.id !== id
      item.element.setAttribute("aria-hidden", String(item.id !== id))
    }
    variantRoot?.querySelectorAll<HTMLButtonElement>("button[data-variant]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.variant === id))
    })
    sync()
    api.dispatchEvent(new CustomEvent("variantchange", { detail: { id } }))
    if (save) host.saveView()
  }
  api.variants = (items) => {
    if (
      !items.length ||
      items.length > 12 ||
      new Set(items.map((item) => item.id)).size !== items.length ||
      items.some((item) => !item.id || !item.label || !(item.element instanceof HTMLElement))
    )
      throw new Error(L.invalidVariants)
    variantRoot?.remove()
    variants = items
    const root = make("nav")
    root.dataset.renderVariants = ""
    root.setAttribute("aria-label", L.variants)
    for (const item of items) {
      const control = button(item.label, () => selectVariant(item.id))
      control.dataset.variant = item.id
      control.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const index = items.findIndex((value) => value.id === item.id)
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (index + (event.key === "ArrowLeft" ? -1 : 1) + items.length) % items.length
        selectVariant(items[next].id)
        root.querySelectorAll<HTMLButtonElement>("button")[next]?.focus()
      })
      root.append(control)
    }
    variantRoot = root
    if (document.body) document.body.prepend(root)
    else document.addEventListener("DOMContentLoaded", () => document.body.prepend(root), { once: true })
    selectVariant(host.getView().variant ?? items[0].id, false)
  }
  api.addEventListener("statechange", () => {
    if (variants.length) selectVariant(host.getView().variant ?? variants[0].id, false)
    else sync()
  })
  api.calendar = (element, options) => {
    if (options.events.length > 500) throw new Error(L.tooMany)
    const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    if (
      options.events.some(
        (event) => !valid(event.start) || (event.end && (!valid(event.end) || event.end < event.start)),
      )
    )
      throw new Error(L.invalidDate)
    const today = new Date()
    const initial =
      options.events[0]?.start ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`
    let month = new Date(`${initial.slice(0, 7)}-01T12:00:00`)
    function draw() {
      element.replaceChildren()
      element.dataset.renderCalendar = ""
      const toolbar = make("div")
      toolbar.dataset.renderActions = ""
      const title = make(
        "strong",
        new Intl.DateTimeFormat(api.getHostContext().locale, { month: "long", year: "numeric" }).format(month),
      )
      toolbar.append(
        button(L.previous, () => {
          month.setMonth(month.getMonth() - 1)
          draw()
        }),
        title,
        button(L.next, () => {
          month.setMonth(month.getMonth() + 1)
          draw()
        }),
      )
      const grid = make("div")
      grid.dataset.renderCalendarGrid = ""
      const year = month.getFullYear(),
        index = month.getMonth()
      for (let day = 1; day <= new Date(year, index + 1, 0).getDate(); day++) {
        const cell = make("div")
        if (day === 1) cell.style.gridColumnStart = String(new Date(year, index, 1).getDay() + 1)
        const date = `${year}-${String(index + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        cell.append(make("span", String(day)))
        for (const event of options.events.filter(
          (event) => event.start <= date && (event.end ?? event.start) >= date,
        )) {
          const item = button(event.title, () => options.onSelect?.(event.id))
          item.setAttribute("aria-label", `${date} ${event.title}`)
          cell.append(item)
        }
        grid.append(cell)
      }
      element.append(toolbar, grid)
    }
    api.addEventListener("hostcontextchange", draw)
    draw()
  }
  api.icon = (name) => {
    const paths: Record<string, string> = {
      plus: "M12 5v14M5 12h14",
      minus: "M5 12h14",
      check: "m5 12 4 4L19 6",
      close: "m6 6 12 12M6 18 18 6",
      left: "m15 6-6 6 6 6",
      right: "m9 6 6 6-6 6",
      play: "m8 5 11 7-11 7Z",
      pause: "M8 5v14M16 5v14",
      info: "M12 11v6M12 7v1",
    }
    if (!(name in paths)) throw new Error(L.invalidIcon)
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", "0 0 24 24")
    svg.setAttribute("width", "20")
    svg.setAttribute("height", "20")
    svg.setAttribute("aria-hidden", "true")
    svg.setAttribute("fill", "none")
    svg.setAttribute("stroke", "currentColor")
    svg.setAttribute("stroke-width", "1.5")
    const path = document.createElementNS(svg.namespaceURI, "path")
    path.setAttribute("d", paths[name])
    svg.append(path)
    return svg
  }
}

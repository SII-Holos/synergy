import type { RenderUI } from "@ericsanchezok/synergy-util/render-ui"

export function installRenderCatalog(root: HTMLElement, evaluate: typeof RenderUI.evaluate) {
  const elements = new Map<string, { type: string; element: HTMLElement; content: HTMLElement }>()
  let options: {
    locale: string
    disabled: boolean
    followUp?: (text: string) => void
    change?: (key: string, value: RenderUI.Value) => void
  }
  let spec: RenderUI.Spec
  let state: Record<string, RenderUI.Value> = {}
  const document = root.ownerDocument
  const make = (tag: string, text?: string) => {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    return element
  }
  function update(next: RenderUI.Spec, values: Record<string, RenderUI.Value>, config: typeof options) {
    const resolved = evaluate(next, values)
    const value = (binding: RenderUI.Binding) => (typeof binding === "object" ? resolved[binding.ref] : binding)
    const format = (item: RenderUI.Value) =>
      typeof item === "number"
        ? new Intl.NumberFormat(config.locale, { maximumFractionDigits: 6 }).format(item)
        : String(item)
    for (const node of next.nodes) {
      if (node.type === "bar" && node.items.some((item) => typeof value(item.value) !== "number"))
        throw new Error(`Invalid chart values: ${node.id}`)
    }
    spec = next
    state = values
    options = config
    const retained = new Set(next.nodes.map((node) => node.id))
    for (const [id, entry] of elements)
      if (!retained.has(id)) {
        entry.element.remove()
        elements.delete(id)
      }
    const positions = new Map<HTMLElement, number>()
    for (const node of next.nodes) {
      let entry = elements.get(node.id)
      if (entry?.type !== node.type) {
        entry?.element.remove()
        const element = make(node.type === "heading" ? `h${node.level ?? "2"}` : node.type === "text" ? "p" : "div")
        element.dataset.renderNode = node.id
        element.dataset.renderType = node.type
        const content = make("div")
        if (node.type === "row" || node.type === "card") element.append(content)
        entry = { type: node.type, element, content }
        elements.set(node.id, entry)
      }
      const { element, content } = entry
      const parent = node.parent ? elements.get(node.parent)!.content : root
      const index = positions.get(parent) ?? 0
      if (parent.children[index] !== element) parent.insertBefore(element, parent.children[index] ?? null)
      positions.set(parent, index + 1)
      if (node.type === "heading" || node.type === "text") element.textContent = node.text
      if (node.type === "row") content.style.setProperty("--render-columns", String(node.columns ?? 2))
      if (node.type === "card") {
        let title = element.querySelector<HTMLElement>(":scope > h3")
        if (!title && node.title) {
          title = make("h3")
          element.prepend(title)
        }
        if (title) {
          title.textContent = node.title ?? ""
          title.hidden = !node.title
        }
      }
      if (node.type === "metric") {
        if (!element.childElementCount) element.append(make("span"), make("output"))
        element.children[0].textContent = node.label
        element.children[1].textContent = `${node.prefix ?? ""}${format(value(node.value))}${node.suffix ?? ""}`
        element.children[1].setAttribute("aria-label", node.label)
      }
      if (node.type === "slider" || node.type === "select" || node.type === "checkbox") {
        let label = element.querySelector("label")
        if (!label) {
          label = make("label") as HTMLLabelElement
          const control = make(node.type === "select" ? "select" : "input") as HTMLInputElement | HTMLSelectElement
          if (control instanceof document.defaultView!.HTMLInputElement)
            control.type = node.type === "slider" ? "range" : "checkbox"
          label.append(make("span"), control)
          element.append(label, make("output"))
          control.addEventListener("input", () => {
            const current = spec.nodes.find((item) => item.id === node.id)
            if (!current || !("state" in current) || options.disabled) return
            const next =
              current.type === "checkbox"
                ? (control as HTMLInputElement).checked
                : current.type === "slider"
                  ? Number(control.value)
                  : control.value
            options.change?.(current.state, next)
          })
        }
        label.children[0].textContent = node.label
        const control = label.children[1] as HTMLInputElement | HTMLSelectElement
        control.disabled = config.disabled
        if (node.type === "slider") {
          const input = control as HTMLInputElement
          input.min = String(node.min)
          input.max = String(node.max)
          input.step = String(node.step ?? 1)
        }
        if (node.type === "select") {
          const select = control as HTMLSelectElement
          if (JSON.stringify(Array.from(select.options, (option) => option.value)) !== JSON.stringify(node.options))
            select.replaceChildren(...node.options.map((item) => make("option", item)))
        }
        if (node.type === "checkbox") (control as HTMLInputElement).checked = Boolean(values[node.state])
        else if (control.value !== String(values[node.state])) control.value = String(values[node.state])
        const output = element.querySelector("output")!
        output.hidden = node.type !== "slider"
        output.textContent = format(values[node.state])
      }
      if (node.type === "button") {
        let button = element.querySelector("button")
        if (!button) {
          button = make("button") as HTMLButtonElement
          button.type = "button"
          button.addEventListener("click", () => {
            const current = spec.nodes.find((item) => item.id === node.id)
            if (current?.type === "button" && !options.disabled)
              options.followUp?.(`${current.text}\n\nParameters: ${JSON.stringify(state)}`)
          })
          element.append(button)
        }
        button.textContent = node.label
        button.disabled = config.disabled || !config.followUp
      }
      if (node.type === "bar") {
        element.replaceChildren(make("p", node.label))
        const items = node.items.map((item) => ({ label: item.label, value: value(item.value) as number }))
        const max = Math.max(1, ...items.map((item) => Math.abs(item.value)))
        items.forEach((item) => {
          const row = make("div")
          row.append(make("span", item.label), make("output", format(item.value)))
          const bar = make("meter") as HTMLMeterElement
          bar.min = 0
          bar.max = max
          bar.value = Math.abs(item.value)
          bar.setAttribute("aria-label", item.label)
          row.append(bar)
          element.append(row)
        })
      }
    }
  }
  return {
    update,
    dispose() {
      root.replaceChildren()
      elements.clear()
    },
  }
}

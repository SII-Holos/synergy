import { useLingui } from "@lingui/solid"
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { ResourceOpenController, ResourceOpenOptions, ResourcePreview } from "../context/resource-open"
import { useResourcePreviewOwner } from "../context/resource-open"
import { useViewActivity } from "../context/view-activity"
import { Button } from "./button"
import { CopyIconButton } from "./clipboard"
import { IconButton } from "./icon-button"
import { Popover, restorePopoverFocus } from "./popover"
import { ResourceIcon } from "./resource-icon"
import { resourceDisplay } from "./resource-display"
import { getSemanticIcon } from "./semantic-icon"

export const resourcePreviewDescriptors = {
  preview: { id: "ui.resource.preview", message: "Preview reference" },
  open: { id: "ui.resource.open", message: "Open" },
  external: { id: "ui.resource.external", message: "Open in system browser" },
  copy: { id: "ui.resource.copy", message: "Copy link" },
  close: { id: "ui.resource.close", message: "Close preview" },
  loading: { id: "ui.resource.loading", message: "Loading preview…" },
  unavailable: { id: "ui.resource.unavailable", message: "Preview unavailable" },
}

export function ResourcePreviewCard(props: {
  reference: ResourceReference.Target
  preview: ResourcePreview
  loading?: boolean
  resources: ResourceOpenController
  options?: ResourceOpenOptions
  close(): void
}) {
  const { _ } = useLingui()
  const target = () => ResourceReference.format(props.reference)
  const open = (prefer?: "external") => {
    void props.resources.open(props.reference, { ...props.options, signal: undefined, ...(prefer ? { prefer } : {}) })
    props.close()
  }
  return (
    <section data-component="resource-preview" aria-label={_(resourcePreviewDescriptors.preview)}>
      <header>
        <span data-slot="resource-preview-source">
          <ResourceIcon reference={props.reference} />
          {props.preview.source}
        </span>
        <IconButton
          icon={getSemanticIcon("action.close")}
          variant="ghost"
          aria-label={_(resourcePreviewDescriptors.close)}
          onClick={props.close}
        />
      </header>
      <h3>{props.preview.title}</h3>
      <div data-slot="resource-preview-details">
        <Show when={props.preview.path && props.preview.path !== target()}>
          <p data-slot="resource-preview-path">{props.preview.path}</p>
        </Show>
        <Show when={props.loading}>
          <p role="status">{_(resourcePreviewDescriptors.loading)}</p>
        </Show>
        <Show when={props.preview.description}>
          <p>{props.preview.description}</p>
        </Show>
        <Show when={props.preview.code}>
          {(code) => (
            <pre data-language={code().language} tabIndex={0}>
              <code>{code().text}</code>
            </pre>
          )}
        </Show>
        <Show when={props.preview.meta}>
          <p data-slot="resource-preview-meta">{props.preview.meta}</p>
        </Show>
        <Show when={props.preview.unavailable}>
          <p role="status">{props.preview.unavailable}</p>
        </Show>
      </div>
      <a
        data-slot="resource-preview-target"
        href={props.reference.kind === "url" ? target() : undefined}
        onClick={(event) => {
          event.preventDefault()
          open()
        }}
      >
        {target()}
      </a>
      <footer>
        <Button size="small" variant="secondary" icon={getSemanticIcon("action.open")} onClick={() => open()}>
          {props.resources.openLabel?.(props.reference) ?? _(resourcePreviewDescriptors.open)}
        </Button>
        <Show when={props.reference.kind === "url" && /^https?:/i.test(props.reference.url)}>
          <IconButton
            variant="ghost"
            icon={getSemanticIcon("action.external")}
            aria-label={_(resourcePreviewDescriptors.external)}
            title={_(resourcePreviewDescriptors.external)}
            onClick={() => open("external")}
          />
        </Show>
        <CopyIconButton variant="ghost" text={target} copyLabel={_(resourcePreviewDescriptors.copy)} />
      </footer>
    </section>
  )
}

export function MarkdownResourcePreview(props: {
  root(): HTMLElement
  resources: ResourceOpenController
  context(): ResourceReference.Context
}) {
  const { _ } = useLingui()
  const active = useViewActivity()
  const owner = useResourcePreviewOwner()
  const [anchor, setAnchor] = createSignal<HTMLElement>()
  const [reference, setReference] = createSignal<ResourceReference.Target>()
  const [preview, setPreview] = createSignal<ResourcePreview>()
  const [loading, setLoading] = createSignal(false)
  let popup: HTMLDivElement | undefined
  let opening: ReturnType<typeof setTimeout> | undefined
  let closing: ReturnType<typeof setTimeout> | undefined
  let pending: AbortController | undefined
  let intended: HTMLElement | undefined
  let release: (() => void) | undefined
  let restoring: HTMLElement | undefined
  let occurrence = 0
  const focusTarget = () => {
    const element = anchor()
    if (element?.isConnected) return element
    const value = element?.dataset.resourceReference
    return [...props.root().querySelectorAll<HTMLElement>("a")].filter(
      (peer) => (peer.dataset.resourceReference ?? peer.getAttribute("href")) === value,
    )[occurrence]
  }
  const clearTimers = () => {
    clearTimeout(opening)
    clearTimeout(closing)
  }
  const close = (restore = false) => {
    const previous = focusTarget()
    const content = popup?.closest<HTMLElement>('[data-component="popover-content"]')
    clearTimers()
    release?.()
    release = undefined
    pending?.abort()
    pending = undefined
    intended = undefined
    previous?.removeAttribute("data-resource-preview")
    setAnchor(undefined)
    if (restore && active() && previous?.isConnected) {
      restoring = previous
      void restorePopoverFocus(previous, content ?? undefined).finally(() => {
        if (restoring === previous) restoring = undefined
      })
    }
  }
  const options = (): ResourceOpenOptions => ({
    context: props.context(),
    focusTarget,
    signal: pending?.signal,
  })
  const open = (element: HTMLElement, focus = false) => {
    if (!active() || !element.isConnected || element.closest("[inert]")) return
    if (anchor() === element) {
      clearTimers()
      if (focus) popup?.querySelector<HTMLElement>("button")?.focus()
      return
    }
    close()
    const value = element.dataset.resourceReference
    if (!value) return
    occurrence = [...props.root().querySelectorAll<HTMLElement>("a[data-resource-reference]")]
      .filter((peer) => peer.dataset.resourceReference === value)
      .indexOf(element)
    const resource = ResourceReference.parse(value)
    if (resource.kind === "anchor" || resource.kind === "unavailable" || resource.kind === "image") return
    release = owner?.claim(() => close())
    const display = resourceDisplay(resource)
    setReference(resource)
    setPreview({
      title: element.dataset.resourceLabel ?? element.textContent?.trim() ?? display.label,
      source: display.source,
      path: display.file,
    })
    element.dataset.resourcePreview = "true"
    setAnchor(element)
    pending = new AbortController()
    const request = pending
    setLoading(Boolean(props.resources.preview))
    if (props.resources.preview)
      void props.resources
        .preview(resource, options())
        .then((result) => {
          if (request.signal.aborted || anchor() !== element) return
          setPreview(result)
          setLoading(false)
        })
        .catch(() => {
          if (request.signal.aborted || anchor() !== element) return
          setPreview((value) => ({ ...value!, unavailable: _(resourcePreviewDescriptors.unavailable) }))
          setLoading(false)
        })
    if (focus) queueMicrotask(() => popup?.querySelector<HTMLElement>("button")?.focus())
  }
  const schedule = (element: HTMLElement) => {
    clearTimeout(closing)
    if (anchor() === element || intended === element) return
    close()
    release = owner?.claim(() => close())
    intended = element
    opening = setTimeout(() => open(element), 400)
  }
  const leave = () => {
    clearTimeout(opening)
    intended = undefined
    clearTimeout(closing)
    closing = setTimeout(() => close(), 120)
  }
  createEffect(() => {
    props.context()
    props.resources.contextKey?.()
    active()
    untrack(() => close())
  })
  createEffect(() => {
    const root = props.root()
    const find = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("a[data-resource-bound]") : null
    const enter = (event: PointerEvent | FocusEvent) => {
      if (event instanceof PointerEvent && event.pointerType === "touch") return
      const element = find(event.target)
      if (event.type === "focusin" && element === restoring) return
      if (element && !element.contains(event.relatedTarget as Node | null)) schedule(element)
    }
    const exit = (event: PointerEvent | FocusEvent) => {
      if (!find(event.target) || popup?.contains(event.relatedTarget as Node | null)) return
      leave()
    }
    const click = (event: MouseEvent) => {
      const info = event.target instanceof Element ? event.target.closest("button[data-resource-info]") : undefined
      if (!info || !root.contains(info)) return
      event.preventDefault()
      event.stopPropagation()
      const element = info.previousElementSibling
      if (element instanceof HTMLElement) open(element, true)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (anchor() || intended)) {
        event.preventDefault()
        event.stopPropagation()
        close(true)
      } else if (event.key === "Tab" && !event.shiftKey && find(event.target) === anchor()) {
        const button = popup?.querySelector<HTMLElement>("button")
        if (button) {
          event.preventDefault()
          clearTimers()
          button.focus()
        }
      }
    }
    const observer = new MutationObserver(() => {
      if (anchor() && !root.contains(anchor()!)) close(Boolean(popup?.contains(root.ownerDocument.activeElement)))
    })
    observer.observe(root, { childList: true, subtree: true })
    root.addEventListener("pointerover", enter)
    root.addEventListener("pointerout", exit)
    root.addEventListener("focusin", enter)
    root.addEventListener("focusout", exit)
    root.addEventListener("click", click, true)
    root.addEventListener("keydown", key)
    onCleanup(() => {
      close()
      observer.disconnect()
      root.removeEventListener("pointerover", enter)
      root.removeEventListener("pointerout", exit)
      root.removeEventListener("focusin", enter)
      root.removeEventListener("focusout", exit)
      root.removeEventListener("click", click, true)
      root.removeEventListener("keydown", key)
    })
  })
  return (
    <Show when={anchor()}>
      <Popover
        open={Boolean(anchor())}
        onOpenChange={(value) => {
          if (!value) close()
        }}
        anchorRef={anchor}
        modal={false}
        placement="bottom-start"
        gutter={8}
        contentProps={{
          "aria-label": _(resourcePreviewDescriptors.preview),
          onOpenAutoFocus: (event: Event) => event.preventDefault(),
          onCloseAutoFocus: (event: Event) => event.preventDefault(),
          onEscapeKeyDown: (event: KeyboardEvent) => {
            event.preventDefault()
            close(true)
          },
          onPointerEnter: () => clearTimers(),
          onPointerLeave: leave,
          onFocusIn: () => clearTimers(),
          onFocusOut: (event: FocusEvent) => {
            if (!popup?.contains(event.relatedTarget as Node | null)) leave()
          },
        }}
      >
        <div ref={popup}>
          <Show when={reference() && preview()}>
            <ResourcePreviewCard
              reference={reference()!}
              preview={preview()!}
              loading={loading()}
              resources={props.resources}
              options={options()}
              close={() => close(true)}
            />
          </Show>
        </div>
      </Popover>
    </Show>
  )
}

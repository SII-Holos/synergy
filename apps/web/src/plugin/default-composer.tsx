import { DefaultComposerEditor } from "./default-composer-editor"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { PluginComponentProps, PluginInputService } from "@ericsanchezok/synergy-plugin"
import { createSignal, createMemo, createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { ComposerLongEditor } from "@/components/prompt-input/composer-long-editor"
import { ComposerExpandButton } from "@/components/prompt-input/composer-expand-button"
import { composerPresentation } from "@/components/prompt-input/composer-presentation"
import { ComposerResizeControls } from "@/components/prompt-input/composer-resize-controls"
import { createComposerMotion } from "@/components/prompt-input/composer-motion"

export function DefaultComposer(props: PluginComponentProps<{ input: PluginInputService }>) {
  const input = props.context.input
  const binding = composerPresentation(input)
  const [version, setVersion] = createSignal(0)
  const [animating, setAnimating] = createSignal(false)
  let motion: ReturnType<typeof createComposerMotion> | undefined
  let measure = () => {}
  let previousExpanded = !!binding?.state.expanded && input.current().mode === "normal"
  if (binding)
    onCleanup(
      binding.state.subscribe(() => {
        const next = binding.state.expanded && input.current().mode === "normal"
        const changed = next !== previousExpanded
        const token = changed ? motion?.capture() : undefined
        if (!changed) motion?.cancel()
        previousExpanded = next
        setVersion((value) => value + 1)
        if (token !== undefined) queueMicrotask(() => motion?.play(next, token, measure))
      }),
    )
  const expanded = createMemo(() => {
    version()
    return binding?.state.expanded && input.current().mode === "normal"
  })
  let root!: HTMLDivElement
  const [availableHeight, setAvailableHeight] = createSignal(480)
  const [chromeHeight, setChromeHeight] = createSignal(80)
  const manualHeight = () => {
    version()
    return binding?.state.manualHeight
  }
  onMount(() => {
    motion = createComposerMotion(root, setAnimating)
    const pane = root.closest<HTMLElement>(".session-workbench-pane") ?? root.parentElement
    const dock = root.closest(".session-prompt-dock-content")
    const dockContainer = root.closest<HTMLElement>(".session-prompt-dock")
    const activity = dock?.querySelector(".prompt-dock-float-layer")
    const outlet = dock?.querySelector("[data-session-decision-outlet]")
    let paneWidth: number | undefined
    measure = () => {
      const viewport = window.visualViewport
      const rect = pane?.getBoundingClientRect()
      const dockSpacing = dockContainer ? Number.parseFloat(getComputedStyle(dockContainer).paddingBottom) : 0
      const footer =
        root
          .closest(".session-prompt-dock-content")
          ?.querySelector(".session-prompt-dock-footer")
          ?.getBoundingClientRect().height ?? 0
      const topbar =
        pane?.querySelector('[data-ui-part="conversation"]')?.firstElementChild?.getBoundingClientRect().height ?? 0
      const request = outlet?.querySelector("[data-session-decision-stack]")
      const reserved = expanded()
        ? 0
        : (activity?.getBoundingClientRect().height ?? 0) +
          (request
            ? [
                ...request.querySelectorAll(".decision-header, .decision-origin, .decision-footer, .decision-notice"),
              ].reduce((height, element) => height + element.getBoundingClientRect().height, 0) + 36
            : 0)
      const height = Math.max(
        64,
        Math.min(
          rect?.bottom ?? window.innerHeight,
          viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
        ) -
          Math.max(rect?.top ?? 0, viewport?.offsetTop ?? 0) -
          topbar -
          footer -
          reserved -
          dockSpacing -
          8,
      )
      if (Math.abs(height - availableHeight()) > 0.5 || (paneWidth !== undefined && paneWidth !== rect?.width))
        motion?.cancel()
      paneWidth = rect?.width
      setAvailableHeight(height)
      const form = root.querySelector("form")
      const editor = root.querySelector(".session-composer-editor")
      if (form && editor) setChromeHeight(form.getBoundingClientRect().height - editor.getBoundingClientRect().height)
    }
    const observer = new ResizeObserver(measure)
    if (pane) observer.observe(pane)
    if (dockContainer) observer.observe(dockContainer, { box: "border-box" })
    if (activity) observer.observe(activity)
    if (outlet) observer.observe(outlet)
    const form = root.querySelector("form")
    if (form) observer.observe(form)
    measure()
    window.visualViewport?.addEventListener("resize", measure)
    window.addEventListener("resize", measure)
    onCleanup(() => {
      observer.disconnect()
      window.visualViewport?.removeEventListener("resize", measure)
      window.removeEventListener("resize", measure)
      motion?.dispose()
    })
  })
  createEffect(
    on(
      () => input.current().revision,
      () => motion?.cancel(),
      { defer: true },
    ),
  )
  createEffect(
    on(
      expanded,
      () => {
        const editor = root.querySelector<HTMLElement>('[data-component="prompt-input"]')
        queueMicrotask(() => editor?.focus({ preventScroll: true }))
      },
      { defer: true },
    ),
  )
  const report = (error: unknown) =>
    showToast({ type: "error", description: error instanceof Error ? error.message : String(error) })
  return (
    <div
      ref={root}
      class="session-composer relative z-0 w-full flex flex-col overflow-visible"
      data-ui-part="composer"
      data-expanded={expanded() ? "" : undefined}
      data-resized={manualHeight() === undefined ? undefined : ""}
      style={{
        "--composer-available-height": `${availableHeight()}px`,
        "--composer-chrome-height": `${chromeHeight()}px`,
        "--composer-body-height": manualHeight() === undefined ? undefined : `${manualHeight()}px`,
      }}
    >
      {input.render("leading")}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void (input.primaryAction() === "stop" ? input.stop() : input.submit()).catch(report)
        }}
        onDragOver={input.dragOver}
        onDragLeave={input.dragLeave}
        onDrop={(event) => {
          void input.drop(event).catch(report)
        }}
        classList={{
          "prompt-input-shell bg-input-base relative overflow-visible": true,
          "prompt-input-shell-dragging": input.dragging(),
          "border border-border-base": !input.dragging(),
          "border border-icon-info-active border-dashed": input.dragging(),
          [input.className() ?? ""]: !!input.className(),
        }}
        style={{ "z-index": 1 }}
      >
        <Show when={binding}>
          <ComposerResizeControls input={input} availableHeight={availableHeight()} />
        </Show>
        <div class="session-composer-context">{input.render("context")}</div>
        <Show when={binding} fallback={<DefaultComposerEditor context={{ input }} onError={report} />}>
          <ComposerExpandButton input={input} />
          <ComposerLongEditor input={input} report={report} animating={animating()}>
            <DefaultComposerEditor context={{ input }} onError={report} />
          </ComposerLongEditor>
        </Show>
        {input.render("toolbar")}
      </form>
      {input.render("trailing")}
    </div>
  )
}

import { DefaultComposerEditor } from "./default-composer-editor"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { PluginComponentProps, PluginInputService } from "@ericsanchezok/synergy-plugin"
import { createSignal, createMemo, createEffect, on, onCleanup, onMount } from "solid-js"
import { ComposerLongEditor, ComposerExpandButton } from "@/components/prompt-input/composer-long-editor"
import { composerPresentation } from "@/components/prompt-input/composer-presentation"
import { ComposerResizeControls } from "@/components/prompt-input/composer-resize-controls"

export function DefaultComposer(props: PluginComponentProps<{ input: PluginInputService }>) {
  const input = props.context.input
  const binding = composerPresentation(input)
  const [version, setVersion] = createSignal(0)
  if (binding) onCleanup(binding.state.subscribe(() => setVersion((value) => value + 1)))
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
    const pane = root.closest<HTMLElement>(".session-workbench-pane") ?? root.parentElement
    const measure = () => {
      const viewport = window.visualViewport
      const rect = pane?.getBoundingClientRect()
      const footer =
        root
          .closest(".session-prompt-dock-content")
          ?.querySelector(".session-prompt-dock-footer")
          ?.getBoundingClientRect().height ?? 0
      const topbar =
        pane?.querySelector('[data-ui-part="conversation"]')?.firstElementChild?.getBoundingClientRect().height ?? 0
      setAvailableHeight(
        Math.max(
          96,
          Math.min(
            rect?.bottom ?? window.innerHeight,
            viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
          ) -
            Math.max(rect?.top ?? 0, viewport?.offsetTop ?? 0) -
            topbar -
            footer -
            16,
        ),
      )
      const form = root.querySelector("form")
      const editor = root.querySelector(".session-composer-editor")
      if (form && editor) setChromeHeight(form.getBoundingClientRect().height - editor.getBoundingClientRect().height)
    }
    const observer = new ResizeObserver(measure)
    if (pane) observer.observe(pane)
    const form = root.querySelector("form")
    if (form) observer.observe(form)
    measure()
    window.visualViewport?.addEventListener("resize", measure)
    window.addEventListener("resize", measure)
    onCleanup(() => {
      observer.disconnect()
      window.visualViewport?.removeEventListener("resize", measure)
      window.removeEventListener("resize", measure)
    })
  })
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
          "prompt-input-shell bg-input-base relative overflow-hidden": true,
          "prompt-input-shell-dragging": input.dragging(),
          "border border-border-base": !input.dragging(),
          "border border-icon-info-active border-dashed": input.dragging(),
          [input.className() ?? ""]: !!input.className(),
        }}
        style={{ "z-index": 1 }}
      >
        <ComposerResizeControls input={input} availableHeight={availableHeight()} />
        <div class="session-composer-context">{input.render("context")}</div>
        <ComposerExpandButton input={input} />
        <ComposerLongEditor input={input} report={report}>
          <DefaultComposerEditor context={{ input }} onError={report} />
        </ComposerLongEditor>
        {input.render("toolbar")}
      </form>
      {input.render("trailing")}
    </div>
  )
}

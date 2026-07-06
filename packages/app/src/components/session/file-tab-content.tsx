import { createMemo, createEffect, on, Show, Switch, Match, onCleanup } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useCodeComponent } from "@ericsanchezok/synergy-ui/context/code"
import { selectionFromLines, useFile, type SelectedLineRange } from "@/context/file"
import type { useLayout } from "@/context/layout"
import type { usePrompt } from "@/context/prompt"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { filePreviewModel } from "./file-preview-model"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export interface FileTabContentProps {
  tab: string
  isActive: () => boolean
  file: ReturnType<typeof useFile>
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  prompt: ReturnType<typeof usePrompt>
  handoffFiles: Record<string, SelectedLineRange | null>
}

export function FileTabContent(props: FileTabContentProps) {
  const codeComponent = useCodeComponent()

  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let pending: { x: number; y: number } | undefined

  const path = createMemo(() => props.file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return props.file.get(p)
  })
  const content = createMemo(() => state()?.content)
  const preview = createMemo(() => filePreviewModel(content()))
  const contents = createMemo(() => preview().textContent)
  const cacheKey = createMemo(() => checksum(contents()))
  const isImage = createMemo(() => preview().isImage)
  const isSvg = createMemo(() => preview().isSvg)
  const svgContent = createMemo(() => (isSvg() ? preview().textContent : undefined))
  const svgPreviewUrl = createMemo(() => preview().svgPreviewUrl)
  const imageDataUrl = createMemo(() => preview().imageDataUrl)
  const binaryReason = createMemo(() => preview().binaryReason)
  const selectedLines = createMemo(() => {
    const p = path()
    if (!p) return null
    if (props.file.ready()) return props.file.selectedLines(p) ?? null
    return props.handoffFiles[p] ?? null
  })
  const selection = createMemo(() => {
    const range = selectedLines()
    if (!range) return
    return selectionFromLines(range)
  })
  const selectionLabel = createMemo(() => {
    const sel = selection()
    if (!sel) return
    if (sel.startLine === sel.endLine) return `L${sel.startLine}`
    return `L${sel.startLine}-${sel.endLine}`
  })

  const restoreScroll = (retries = 0) => {
    const el = scroll
    if (!el) return

    const s = props.view()?.scroll(props.tab)
    if (!s) return

    if (el.scrollHeight <= el.clientHeight && retries < 10) {
      requestAnimationFrame(() => restoreScroll(retries + 1))
      return
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      props.view().setScroll(props.tab, next)
    })
  }

  createEffect(
    on(
      () => state()?.loaded,
      (loaded) => {
        if (!loaded) return
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.file.ready(),
      (ready) => {
        if (!ready) return
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.isActive(),
      (active) => {
        if (!active) return
        if (!state()?.loaded) return
        requestAnimationFrame(restoreScroll)
      },
    ),
  )

  onCleanup(() => {
    if (scrollFrame === undefined) return
    cancelAnimationFrame(scrollFrame)
  })

  return (
    <Tabs.Content
      value={props.tab}
      class="mt-3"
      ref={(el: HTMLDivElement) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <Show when={props.isActive()}>
        <Show when={selection()}>
          {(sel) => (
            <div class="hidden sticky top-0 z-10 px-6 py-2 _flex justify-end bg-background-base border-b border-border-weak-base">
              <button
                type="button"
                class="flex items-center gap-2 px-2 py-1 rounded-md bg-surface-base border border-border-base text-12-regular text-text-strong hover:bg-surface-raised-base-hover"
                onClick={() => {
                  const p = path()
                  if (!p) return
                  props.prompt.context.add({ type: "file", path: p, selection: sel() })
                }}
              >
                <Icon name={getSemanticIcon("action.add")} size="small" />
                <span>Add {selectionLabel()} to context</span>
              </button>
            </div>
          )}
        </Show>
        <Switch>
          <Match when={state()?.loaded && isImage()}>
            <div class="px-6 py-4 pb-40">
              <img src={imageDataUrl()} alt={path()} class="max-w-full" />
            </div>
          </Match>
          <Match when={state()?.loaded && isSvg()}>
            <div class="flex flex-col gap-4 px-6 py-4">
              <Dynamic
                component={codeComponent}
                file={{
                  name: path() ?? "",
                  contents: svgContent() ?? "",
                  cacheKey: cacheKey(),
                }}
                enableLineSelection
                selectedLines={selectedLines()}
                onLineSelected={(range: SelectedLineRange | null) => {
                  const p = path()
                  if (!p) return
                  props.file.setSelectedLines(p, range)
                }}
                overflow="scroll"
                class="select-text"
              />
              <Show when={svgPreviewUrl()}>
                <div class="flex justify-center pb-40">
                  <img src={svgPreviewUrl()} alt={path()} class="max-w-full max-h-96" />
                </div>
              </Show>
            </div>
          </Match>
          <Match when={state()?.loaded && binaryReason()}>
            {(reason) => <div class="px-6 py-4 text-text-weak">{reason()}</div>}
          </Match>
          <Match when={state()?.loaded && content()?.kind === "text"}>
            <Dynamic
              component={codeComponent}
              file={{
                name: path() ?? "",
                contents: contents(),
                cacheKey: cacheKey(),
              }}
              enableLineSelection
              selectedLines={selectedLines()}
              onLineSelected={(range: SelectedLineRange | null) => {
                const p = path()
                if (!p) return
                props.file.setSelectedLines(p, range)
              }}
              overflow="scroll"
              class="select-text pb-40"
            />
          </Match>
          <Match when={state()?.loading}>
            <div class="px-6 py-4 text-text-weak">Loading...</div>
          </Match>
          <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
        </Switch>
      </Show>
    </Tabs.Content>
  )
}

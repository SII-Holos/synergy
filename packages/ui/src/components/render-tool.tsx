import { useLingui } from "@lingui/solid"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show, untrack } from "solid-js"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { useDialog } from "../context/dialog"
import { RenderStateConflict, useRenderHost } from "../context/render"
import { BasicTool } from "./basic-tool"
import { Button } from "./button"
import { Dialog } from "./dialog"
import { IconButton } from "./icon-button"
import { RenderHtml, renderHtmlDocument, readThemeCss, readHostContext } from "./render-html"
import { loadRenderLibraries } from "./render/libraries"
import { localizeRenderLabels, renderLabels } from "./render/labels"
import { getSemanticIcon } from "./semantic-icon"
import { Spinner } from "./spinner"
import { TOOL_TITLE_DESC } from "./tool-title-descriptors"
import { ToolTextOutput } from "./tool-output-text"
import type { ToolProps } from "./tool-registry-lazy"
import "./render-tool.css"

const C = {
  visual: { id: "tool.render.visual", message: "Visual result" },
  expand: { id: "tool.render.expand", message: "Expand visual" },
  preparing: { id: "tool.render.preparing", message: "Preparing visual" },
  download: { id: "tool.render.download", message: "Export interactive HTML" },
  feedback: { id: "tool.render.selectFeedback", message: "Select an element for feedback" },
  stopFeedback: { id: "tool.render.stopFeedback", message: "Finish selecting" },
}

export function RenderTool(props: ToolProps & { expanded?: boolean }) {
  const { _, i18n } = useLingui(),
    dialog = useDialog(),
    host = useRenderHost()
  const active = () => ["pending", "generating", "running"].includes(props.status ?? "")
  const descriptor = createMemo(() =>
    props.status === "completed" ? RenderArtifact.descriptor(props.metadata) : undefined,
  )
  const target = () =>
    RenderArtifact.Target.parse({ sessionID: props.sessionId, messageID: props.messageId, partID: props.partId })
  const key = createMemo(
    () => descriptor() && [props.sessionId, props.messageId, props.partId, descriptor()!.source].join("/"),
  )
  let loading: AbortController | undefined
  let viewerID: string | undefined
  let flushInline: (() => Promise<void>) | undefined
  let flushExpanded: (() => Promise<void>) | undefined
  const [expanded, setExpanded] = createSignal(false)
  const [feedback, setFeedback] = createSignal(false)
  const [acknowledged, setAcknowledged] = createSignal(RenderArtifact.emptyState())
  const [exporting, setExporting] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let writeEpoch = 0
  let disposed = false
  let writes = Promise.resolve<RenderArtifact.State>(RenderArtifact.emptyState())
  const [snapshot, { refetch }] = createResource(key, async () => {
    loading?.abort()
    loading = new AbortController()
    if (!host) throw new Error(_(renderLabels.unavailable))
    return host.read(target(), loading.signal)
  })
  createEffect(() => {
    key()
    untrack(() => {
      setAcknowledged(RenderArtifact.emptyState())
      setError(undefined)
      if (viewerID) dialog.close(viewerID)
    })
  })
  const loaded = () => (snapshot.error || snapshot.loading ? undefined : snapshot())
  const state = createMemo(() =>
    [RenderArtifact.state(props.metadata), acknowledged(), loaded()?.state ?? RenderArtifact.emptyState()].reduce(
      (newest, next) => (next.revision > newest.revision ? next : newest),
    ),
  )
  // Historical unversioned results enter the same surface with static execution policy.
  const html = () =>
    loaded()?.source.html ??
    (props.status === "completed" && typeof props.metadata?.html === "string" && props.metadata.html.trim()
      ? (props.metadata.html as string)
      : undefined)
  const title = () =>
    descriptor()?.title ??
    (typeof props.input.artifactTitle === "string" && props.input.artifactTitle.trim()
      ? (props.input.artifactTitle as string)
      : _(C.visual))
  function save(content: RenderArtifact.Content, mutationID: string, revision: number) {
    const captured = untrack(key),
      destination = target(),
      epoch = writeEpoch
    writes = writes
      .catch(() => state())
      .then(async () => {
        if (disposed || key() !== captured || epoch !== writeEpoch || !host) throw new Error(_(renderLabels.closed))
        try {
          const saved = await host.write(destination, { revision, mutationID, content })
          if (!disposed && key() === captured) setAcknowledged(saved)
          return saved
        } catch (error) {
          writeEpoch++
          if (!disposed && key() === captured && error instanceof RenderStateConflict) setAcknowledged(error.state)
          throw error
        }
      })
    return writes
  }
  const followUp = (input: RenderArtifact.FollowUp) => {
    if (!host || !loaded()) return Promise.reject(new Error(_(renderLabels.unavailable)))
    return host.followUp(target(), loaded()!.source, input)
  }
  const view = (isExpanded: boolean, close?: () => void) => (
    <RenderHtml
      html={html()!}
      title={title()}
      source={loaded()?.source}
      state={state()}
      maxHeight={480}
      expanded={isExpanded}
      active={isExpanded || !expanded()}
      feedback={feedback()}
      onEscape={close}
      onState={save}
      onFollowUp={followUp}
      onReady={(flush) => {
        if (isExpanded) flushExpanded = flush
        else flushInline = flush
      }}
    />
  )
  async function expand() {
    if (!html() || viewerID) return
    const captured = key()
    try {
      await flushInline?.()
    } catch (failure) {
      setError(String(failure))
      return
    }
    if (key() !== captured || viewerID) return
    setExpanded(true)
    viewerID = dialog.push(
      () => (
        <div data-component="render-viewer">
          <Dialog title={title()} size="content">
            <div data-slot="render-viewer-actions">{actions(false)}</div>
            {view(true, () => dialog.close(viewerID))}
          </Dialog>
        </div>
      ),
      () => {
        viewerID = undefined
        setExpanded(false)
      },
    )
  }
  async function download() {
    if (!html()) return
    setExporting(true)
    setError(undefined)
    try {
      await (expanded() || props.expanded ? flushExpanded?.() : flushInline?.())
      await writes
      const source = loaded()?.source
      const context = readHostContext(i18n().locale, 1024, true)
      context.viewMode = "export"
      const document = renderHtmlDocument(
        html()!,
        readThemeCss(),
        {
          nonce: generateSecureUUID(),
          version: source?.id ?? "static",
          offline: true,
          interactive: source?.mode === "interactive",
          revision: state().revision,
          state: state().content,
          context,
          labels: localizeRenderLabels(_),
        },
        await loadRenderLibraries(source?.libraries ?? []),
      )
      const url = URL.createObjectURL(new Blob([document], { type: "text/html" }))
      const link = window.document.createElement("a")
      link.href = url
      link.download = `${title()
        .replace(/[^\p{L}\p{N}_-]/gu, "_")
        .slice(0, 80)}.html`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setExporting(false)
    }
  }
  const actions = (canExpand: boolean) => (
    <div data-slot="render-actions">
      <Show when={loaded()?.source.mode === "interactive"}>
        <Button size="small" variant="ghost" aria-pressed={feedback()} onClick={() => setFeedback((value) => !value)}>
          {_(feedback() ? C.stopFeedback : C.feedback)}
        </Button>
      </Show>
      <IconButton
        icon={getSemanticIcon("action.download")}
        variant="ghost"
        aria-label={_(C.download)}
        disabled={exporting()}
        onClick={download}
      />
      <Show when={canExpand}>
        <IconButton icon={getSemanticIcon("action.expand")} variant="ghost" aria-label={_(C.expand)} onClick={expand} />
      </Show>
    </div>
  )
  onCleanup(() => {
    disposed = true
    loading?.abort()
    if (viewerID) dialog.close(viewerID)
  })
  return (
    <Show
      when={active() || !!html() || !!descriptor()}
      fallback={
        <BasicTool {...props} trigger={{ icon: "code", title: TOOL_TITLE_DESC.render }}>
          <Show when={props.output}>
            {(output) => (
              <div data-component="tool-output" data-scrollable>
                <ToolTextOutput text={output()} />
              </div>
            )}
          </Show>
        </BasicTool>
      }
    >
      <figure
        data-component="render-tool"
        data-layout={descriptor()?.layout ?? "normal"}
        aria-busy={active() || snapshot.loading}
      >
        <Show when={error() || snapshot.error}>
          {(message) => (
            <div data-slot="render-error" role="alert">
              <span>{String(message())}</span>
              <Button size="small" variant="ghost" onClick={() => refetch()}>
                {_(renderLabels.retry)}
              </Button>
            </div>
          )}
        </Show>
        <Show
          when={html()}
          fallback={
            <div data-slot="render-tool-loading" role="status">
              <span aria-hidden="true">
                <Spinner />
              </span>
              <span>{_(C.preparing)}</span>
            </div>
          }
        >
          {view(props.expanded ?? false)}
        </Show>
        <figcaption>
          <span>{title()}</span>
          <Show when={html()}>{actions(!props.expanded)}</Show>
        </figcaption>
      </figure>
    </Show>
  )
}

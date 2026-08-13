import { FileDiff, type FileDiffMetadata } from "@pierre/diffs"
import { useLingui } from "@lingui/solid"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, onCleanup, Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { createDefaultOptions, styleVariables } from "../pierre"
import { getWorkerPool } from "../pierre/worker"
import { ensureSynergyHighlightTheme } from "../context/marked"
import { parseRenderablePatch } from "./diff-patch-utils"
import { DIFF_DESC } from "./tool-title-descriptors"
import "./tool/diff-preview.css"

export { canRenderPatch } from "./diff-patch-utils"

export interface DiffPatchProps {
  patch: string
  diffStyle?: "unified" | "split"
  class?: string
  classList?: ComponentProps<"div">["classList"]
  /** Pre-parsed single-file metadata; DiffPatch parses `patch` when omitted. */
  metadata?: FileDiffMetadata
}

/**
 * Renders a single-file unified diff text with pierre (syntax highlighting,
 * unified/split layout, line numbers). Plain text is painted synchronously and
 * swapped for the highlighter render once the theme and worker pool are ready,
 * so the container is never blank — including during streaming when the worker
 * pool is still cold. Parsing or rendering failures stay on plain text.
 */
export function DiffPatch(props: DiffPatchProps) {
  const { _ } = useLingui()
  let container!: HTMLDivElement
  const [local] = splitProps(props, ["patch", "diffStyle", "class", "classList", "metadata"])

  const mobile = createMediaQuery("(max-width: 640px)")

  // Value-stable gate: streaming projections rebuild wrapper objects around
  // an unchanged patch string. The string memo stops that churn here so the
  // parse and render effects below only re-run when the patch truly changes.
  const patchText = createMemo(() => local.patch)
  const metadata = createMemo<FileDiffMetadata | undefined>(() => local.metadata ?? parseRenderablePatch(patchText()))

  const options = createMemo(() => {
    const opts = {
      ...createDefaultOptions(local.diffStyle),
      disableErrorHandling: true,
    }
    if (!mobile()) return opts
    return {
      ...opts,
      disableLineNumbers: true,
    }
  })

  let instance: FileDiff | undefined

  const renderPlainPatch = (patch: string) => {
    instance?.cleanUp()
    instance = undefined
    const fallback = document.createElement("pre")
    fallback.dataset.component = "diff-patch-fallback"
    fallback.dataset.slot = "diff-preview-body"
    fallback.setAttribute("aria-label", _(DIFF_DESC.fileDiffPreview))
    fallback.textContent = patch
    container.replaceChildren(fallback)
  }

  createEffect(() => {
    const parsed = metadata()
    const patch = patchText()
    if (!parsed) {
      renderPlainPatch(patch)
      return
    }
    // Read reactive values synchronously so Solid tracks them; a diffStyle
    // change must re-run this effect and re-render with the new layout.
    const opts = options()
    let alive = true

    // Paint readable plain text immediately. The async upgrade below replaces
    // it in place; if this effect re-runs (new patch or layout) the stale
    // upgrade is discarded via `alive` and the next cycle paints plain text
    // first, so the container never sits empty.
    renderPlainPatch(patch)
    void ensureSynergyHighlightTheme()
      .then(() => {
        if (!alive) return
        try {
          const pool = getWorkerPool(local.diffStyle)
          instance?.cleanUp()
          instance = undefined
          const nextInstance = new FileDiff(opts, pool)
          instance = nextInstance
          container.innerHTML = ""
          nextInstance.render({ fileDiff: parsed, containerWrapper: container })
        } catch {
          if (alive) renderPlainPatch(patch)
        }
      })
      .catch(() => {
        if (alive) renderPlainPatch(patch)
      })
    onCleanup(() => {
      alive = false
    })
  })

  onCleanup(() => {
    instance?.cleanUp()
  })

  return (
    <div
      data-component="diff-patch"
      classList={{
        [local.class ?? ""]: !!local.class,
        ...(local.classList ?? {}),
      }}
      style={styleVariables}
      ref={container}
    />
  )
}

export interface DiffPatchGateProps extends Omit<DiffPatchProps, "patch" | "metadata"> {
  patch: string | undefined | null
  fallback?: JSX.Element
}

/**
 * Decides between the rich pierre render and `fallback` with a single parse
 * per patch-string change, then forwards the parsed metadata so DiffPatch does
 * not parse again. Streaming projections that rebuild wrapper objects around
 * an unchanged patch string cost nothing here.
 */
export function DiffPatchGate(props: DiffPatchGateProps) {
  const [local, others] = splitProps(props, ["patch", "fallback"])
  const patchText = createMemo(() => local.patch ?? "")
  const metadata = createMemo(() => parseRenderablePatch(patchText()))
  return (
    <Show when={metadata()} fallback={local.fallback}>
      {(parsed) => <DiffPatch {...others} patch={patchText()} metadata={parsed()} />}
    </Show>
  )
}

import { FileDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { useLingui } from "@lingui/solid"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, onCleanup, splitProps, type ComponentProps } from "solid-js"
import { createDefaultOptions, styleVariables } from "../pierre"
import { getWorkerPool } from "../pierre/worker"
import { ensureSynergyHighlightTheme } from "../context/marked"
import { canRenderPatch } from "./diff-patch-utils"
import { DIFF_DESC } from "./tool-title-descriptors"
import "./tool/diff-preview.css"

export interface DiffPatchProps {
  patch: string
  diffStyle?: "unified" | "split"
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

export { canRenderPatch }

/**
 * Renders a single-file unified diff text with pierre (syntax highlighting,
 * unified/split layout, line numbers). Callers can gate mounting via
 * `canRenderPatch`; parsing or rendering failures fall back to plain text.
 */
export function DiffPatch(props: DiffPatchProps) {
  const { _ } = useLingui()
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, ["patch", "diffStyle", "class", "classList"])

  const mobile = createMediaQuery("(max-width: 640px)")

  const fileDiff = createMemo<FileDiffMetadata | undefined>(() => {
    try {
      const parsed = parsePatchFiles(local.patch)
      const files = parsed[0]?.files
      return files?.length === 1 ? files[0] : undefined
    } catch {
      return undefined
    }
  })

  const options = createMemo(() => {
    const opts = {
      ...createDefaultOptions(local.diffStyle),
      ...others,
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
    const metadata = fileDiff()
    const patch = local.patch
    if (!metadata) {
      renderPlainPatch(patch)
      return
    }
    // Read reactive values synchronously so Solid tracks them; a diffStyle
    // change must re-run this effect and re-render with the new layout.
    const opts = options()
    let alive = true
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
          nextInstance.render({ fileDiff: metadata, containerWrapper: container })
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

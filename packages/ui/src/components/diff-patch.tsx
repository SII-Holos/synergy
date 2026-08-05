import { FileDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, onCleanup, onMount, splitProps, type ComponentProps } from "solid-js"
import { createDefaultOptions, styleVariables } from "../pierre"
import { getWorkerPool } from "../pierre/worker"
import { ensureSynergyHighlightTheme } from "../context/marked"
import { canRenderPatch } from "./diff-patch-utils"

export interface DiffPatchProps {
  patch: string
  diffStyle?: "unified" | "split"
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

export { canRenderPatch }

/**
 * Renders a single-file unified diff text with pierre (syntax highlighting,
 * unified/split layout, line numbers). Falls back to plain rendering when the
 * patch cannot be parsed. The caller decides whether to mount this component
 * via `canRenderPatch`.
 */
export function DiffPatch(props: DiffPatchProps) {
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
    }
    if (!mobile()) return opts
    return {
      ...opts,
      disableLineNumbers: true,
    }
  })

  let instance: FileDiff | undefined

  createEffect(() => {
    const metadata = fileDiff()
    if (!metadata) return
    // Read reactive values synchronously so Solid tracks them; a diffStyle
    // change must re-run this effect and re-render with the new layout.
    const opts = options()
    const pool = getWorkerPool(local.diffStyle)
    let alive = true
    void ensureSynergyHighlightTheme().then(() => {
      if (!alive) return
      instance?.cleanUp()
      instance = new FileDiff(opts, pool)
      container.innerHTML = ""
      instance.render({ fileDiff: metadata, containerWrapper: container })
    })
    onCleanup(() => {
      alive = false
    })
  })

  onMount(() => {
    void ensureSynergyHighlightTheme()
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

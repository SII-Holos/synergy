import { highlightInputAllowed } from "../pierre/cache-budget"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { FileDiff } from "@pierre/diffs"
import { createMediaQuery } from "@solid-primitives/media"
import { createEffect, createMemo, onCleanup, splitProps } from "solid-js"
import { createDefaultOptions, type DiffProps, styleVariables } from "../pierre"
import { getWorkerPool } from "../pierre/worker"

export function Diff<T>(props: DiffProps<T>) {
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, ["before", "after", "class", "classList", "annotations"])

  const mobile = createMediaQuery("(max-width: 640px)")

  const options = createMemo(() => {
    const opts = {
      ...createDefaultOptions(props.diffStyle),
      ...others,
    }
    if (!mobile()) return opts
    return {
      ...opts,
      disableLineNumbers: true,
    }
  })

  let instance: FileDiff<T> | undefined

  createEffect(() => {
    const opts = options()
    const workerPool = getWorkerPool(props.diffStyle)
    const annotations = local.annotations
    const beforeContents = typeof local.before?.contents === "string" ? local.before.contents : ""
    const afterContents = typeof local.after?.contents === "string" ? local.after.contents : ""

    const plain =
      beforeContents.length + afterContents.length > 32 * 1024 ||
      !highlightInputAllowed(beforeContents) ||
      !highlightInputAllowed(afterContents)
    instance?.cleanUp()
    instance = new FileDiff<T>(opts, workerPool)

    container.innerHTML = ""
    instance.render({
      oldFile: {
        ...local.before,
        contents: beforeContents,
        ...(plain ? { lang: "text" as const } : {}),
        cacheKey: `${plain ? "plain:" : ""}${checksum(beforeContents)}`,
      },
      newFile: {
        ...local.after,
        contents: afterContents,
        ...(plain ? { lang: "text" as const } : {}),
        cacheKey: `${plain ? "plain:" : ""}${checksum(afterContents)}`,
      },
      lineAnnotations: annotations,
      containerWrapper: container,
    })
  })

  onCleanup(() => {
    instance?.cleanUp()
  })

  return <div data-component="diff" style={styleVariables} ref={container} />
}

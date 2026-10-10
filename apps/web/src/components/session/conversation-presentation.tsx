import { createEffect, createMemo, createRenderEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { AP } from "../../app-i18n"
import "./conversation-presentation.css"

export function ConversationPresentation(props: {
  owner: readonly [server: string, scope: string, session: string]
  ready: boolean
  onLeave?: () => void
  children: JSX.Element
}) {
  const { _ } = useLingui()
  const owner = createMemo(() => JSON.stringify(props.owner))
  const ready = createMemo(() => props.ready)
  let live!: HTMLDivElement
  let retained!: HTMLDivElement
  let outgoing: HTMLElement | undefined
  let shown = false
  let generation = 0
  const [waiting, setWaiting] = createSignal(false)
  const [hint, setHint] = createSignal(false)
  const release = () => {
    outgoing?.remove()
    outgoing = undefined
  }
  createRenderEffect(
    on(owner, (_next, previous) => {
      generation++
      props.onLeave?.()
      const before = previous ? (JSON.parse(previous) as string[]) : undefined
      const sameScope = before && before[0] === props.owner[0] && before[1] === props.owner[1]
      if (!sameScope) release()
      else if (shown && before[2] && live && retained) {
        release()
        const frame = live.cloneNode(true) as HTMLElement
        frame.removeAttribute("data-conversation-current")
        frame.inert = true
        frame.setAttribute("aria-hidden", "true")
        frame.style.opacity = "1"
        frame.style.visibility = "visible"
        const originals = [live, ...live.querySelectorAll<HTMLElement>("*")]
        const copies = [frame, ...frame.querySelectorAll<HTMLElement>("*")]
        retained.append(frame)
        for (let index = 0; index < originals.length; index++) {
          const source = originals[index],
            copy = copies[index]
          copy.removeAttribute("id")
          copy.scrollTop = source.scrollTop
          copy.scrollLeft = source.scrollLeft
          if (
            source.hasAttribute("data-motion-changing") ||
            source.matches('[data-conversation-motion], [data-slot="process-viewport-motion"]')
          ) {
            const style = getComputedStyle(source)
            copy.style.height = `${source.getBoundingClientRect().height}px`
            copy.style.opacity = style.opacity
            copy.style.transform = style.transform
          }
          if (source instanceof HTMLCanvasElement && copy instanceof HTMLCanvasElement)
            copy.getContext("2d")?.drawImage(source, 0, 0)
        }
        outgoing = frame
      }
      shown = false
      setWaiting(!!outgoing)
    }),
  )
  createEffect(() => {
    if (!waiting()) {
      setHint(false)
      return
    }
    const timer = setTimeout(() => setHint(true), 180)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => {
    const currentOwner = owner()
    if (!ready()) return
    const current = generation
    const frame = requestAnimationFrame(() => {
      if (generation !== current || currentOwner !== owner() || !ready()) return
      shown = true
      release()
      setWaiting(false)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  onCleanup(release)
  return (
    <div
      data-ui-part="conversation"
      data-conversation-presentation
      class="relative flex-1 min-h-0 min-w-0 overflow-hidden"
    >
      <div ref={retained} data-conversation-retained inert aria-hidden="true" />
      <div
        ref={live}
        data-conversation-current
        class="relative h-full min-h-0 min-w-0 flex flex-col"
        inert={waiting()}
        aria-hidden={waiting()}
        style={{ opacity: waiting() ? 0 : 1 }}
      >
        {props.children}
      </div>
      <Show when={hint()}>
        <div data-conversation-switching role="status">
          {_(AP.sessionLoading)}
        </div>
      </Show>
    </div>
  )
}

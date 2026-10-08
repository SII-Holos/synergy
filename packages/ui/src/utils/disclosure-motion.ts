import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"

export function createDisclosureMotion(
  element: HTMLElement,
  content = false,
  onHidden?: () => void,
  resize: boolean | (() => boolean) = true,
  onSettled?: () => void,
) {
  const window = element.ownerDocument.defaultView
  const reduced = window?.matchMedia?.("(prefers-reduced-motion: reduce)")
  let animation: Animation | undefined
  let visible: boolean | undefined
  const cancel = () => {
    if (!animation) return
    animation.onfinish = null
    animation.cancel()
    animation = undefined
  }
  const settle = () => {
    cancel()
    element.hidden = !visible
    element.inert = !visible
    element.removeAttribute("data-motion-changing")
    element.removeAttribute("data-motion-exiting")
    if (!visible) onHidden?.()
    onSettled?.()
  }
  const changedPreference = () => {
    if (reduced?.matches) settle()
  }
  reduced?.addEventListener?.("change", changedPreference)

  return {
    setVisible(next: boolean, animate = false, appear = false) {
      if (next === visible) {
        if (!animate || reduced?.matches) settle()
        return
      }
      const initial = visible === undefined
      const animated =
        animate &&
        !reduced?.matches &&
        typeof element.animate === "function" &&
        (!initial || (next && appear)) &&
        !(content && next && !appear)
      const resizing = (typeof resize === "function" ? resize() : resize) && !(next && content)
      const height = resizing && animated && !element.hidden ? element.getBoundingClientRect().height : 0
      const painted = animation && animated ? window?.getComputedStyle(element) : undefined
      const opacity = painted?.opacity ?? (next ? 0.65 : 1)
      const transform = painted?.transform ?? (next ? "translateY(2px)" : "translateY(0)")
      cancel()
      visible = next
      element.inert = !next
      if (next) element.removeAttribute("aria-hidden")
      else element.setAttribute("aria-hidden", "true")
      if (!animated) {
        settle()
        return
      }
      element.hidden = false
      const style = window?.getComputedStyle(element)
      const role = next ? "base" : "slow"
      const duration = style?.getPropertyValue(`--motion-duration-${role}`).trim() ?? ""
      const milliseconds = duration ? parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000) : next ? 180 : 240
      const easing = style?.getPropertyValue("--motion-ease-standard").trim() || "cubic-bezier(0.2, 0, 0, 1)"
      const frames: Keyframe[] =
        next && content
          ? [{ opacity }, { opacity: 1 }]
          : !resizing
            ? [
                { opacity, transform },
                { opacity: next ? 1 : 0, transform: "translateY(0)" },
              ]
            : [
                { height: `${initial ? 0 : height}px`, minHeight: "0px", opacity },
                {
                  height: `${next ? element.getBoundingClientRect().height : 0}px`,
                  minHeight: "0px",
                  opacity: next ? 1 : 0,
                },
              ]
      element.setAttribute("data-motion-changing", "")
      if (!next) element.setAttribute("data-motion-exiting", "")
      const current = element.animate(frames, { duration: milliseconds, easing, fill: "both" })
      animation = current
      current.onfinish = () => {
        if (animation === current) settle()
      }
    },
    dispose() {
      cancel()
      reduced?.removeEventListener?.("change", changedPreference)
      element.removeAttribute("data-motion-changing")
      element.removeAttribute("data-motion-exiting")
    },
  }
}

export function createDisclosureMotionRef(options: {
  visible: () => boolean
  animate: () => boolean
  appear?: () => boolean
  content?: boolean
  resize?: boolean | (() => boolean)
  onHidden?: () => void
  onSettled?: () => void
}) {
  const [element, setElement] = createSignal<HTMLElement>()
  const visible = createMemo(options.visible)
  createEffect(() => {
    const target = element()
    if (!target) return
    const motion = createDisclosureMotion(target, options.content, options.onHidden, options.resize, options.onSettled)
    createEffect(() => {
      const next = visible()
      untrack(() => motion.setVisible(next, options.animate(), options.appear?.()))
    })
    onCleanup(() => motion.dispose())
  })
  return (target: HTMLElement) => {
    target.hidden = !untrack(visible)
    setElement(target)
    onCleanup(() => {
      if (untrack(element) === target) setElement(undefined)
    })
  }
}

type MotionSnapshot = {
  height: number
  width?: number
  background: string
  rows: string
  columns: string
  toolsOpacity: string
  previewOpacity: string
  toolsTransform?: string
  previewTransform?: string
  padding: string
  gutter: string
  scrollTop: number
}

export function createComposerMotion(root: HTMLElement, active: (value: boolean) => void) {
  const column = root.closest<HTMLElement>(".session-prompt-dock-content")
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
  let generation = 0
  let animations: Animation[] = []
  let snapshot: MotionSnapshot | undefined
  const elements = () => ({
    tools: root.querySelector<HTMLElement>(".composer-long-tools-presence"),
    panes: root.querySelector<HTMLElement>(".composer-long-panes"),
    preview: root.querySelector<HTMLElement>(".composer-long-preview"),
    editor: root.querySelector<HTMLElement>(".session-composer-editor"),
    form: root.querySelector<HTMLElement>("form"),
    content: root.querySelector<HTMLElement>('[data-component="prompt-input"]'),
  })
  const stop = (settle: boolean) => {
    generation++
    snapshot = undefined
    for (const animation of animations) animation.cancel()
    animations = []
    root.removeAttribute("data-motion")
    if (settle) active(false)
  }
  const preference = () => {
    if (reduced.matches) stop(true)
  }
  reduced.addEventListener("change", preference)
  return {
    capture() {
      const { tools, panes, preview, editor, form, content } = elements()
      const reversing = root.hasAttribute("data-motion")
      const before: MotionSnapshot = {
        height: root.getBoundingClientRect().height,
        width: column?.getBoundingClientRect().width,
        background: getComputedStyle(root).backgroundColor,
        rows: tools ? getComputedStyle(tools).gridTemplateRows : "0px",
        columns: panes ? getComputedStyle(panes).gridTemplateColumns : "none",
        toolsOpacity: tools ? getComputedStyle(tools).opacity : "0",
        previewOpacity: preview ? getComputedStyle(preview).opacity : "0",
        toolsTransform: reversing && tools ? getComputedStyle(tools).transform : undefined,
        previewTransform: reversing && preview ? getComputedStyle(preview).transform : undefined,
        padding: form ? getComputedStyle(form).paddingTop : "0px",
        gutter: content ? getComputedStyle(content).paddingRight : "0px",
        scrollTop: editor?.scrollTop ?? 0,
      }
      stop(false)
      if (reduced.matches || !root.isConnected) {
        active(false)
        return generation
      }
      snapshot = before
      active(true)
      return generation
    },
    play(expanded: boolean, token: number, measure: () => void) {
      if (token !== generation || !snapshot) return
      if (reduced.matches || !root.isConnected) return stop(true)
      measure()
      if (token !== generation || !snapshot) return
      const before = snapshot
      const { tools, panes, preview, editor, form, content } = elements()
      const height = root.getBoundingClientRect().height
      const width = column?.getBoundingClientRect().width
      const background = getComputedStyle(root).backgroundColor
      const rows = tools ? getComputedStyle(tools).gridTemplateRows : "0px"
      const columns = panes ? getComputedStyle(panes).gridTemplateColumns : "none"
      const padding = form ? getComputedStyle(form).paddingTop : "0px"
      const gutter = content ? getComputedStyle(content).paddingRight : "0px"
      root.setAttribute("data-motion", expanded ? "expanding" : "collapsing")
      const duration = expanded ? 340 : 240
      const options: KeyframeAnimationOptions = {
        duration,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        fill: "both",
      }
      const animate = (element: HTMLElement, frames: Keyframe[], timing = options) => {
        const animation = element.animate(frames, timing)
        animations.push(animation)
        return animation
      }
      const sizing = animate(root, [
        { height: `${before.height}px`, backgroundColor: before.background },
        { height: `${height}px`, backgroundColor: background },
      ])
      if (column && before.width !== undefined && width !== undefined && Math.abs(width - before.width) > 0.5)
        animate(column, [{ maxWidth: `${before.width}px` }, { maxWidth: `${width}px` }])
      if (form) animate(form, [{ paddingTop: before.padding }, { paddingTop: padding }])
      if (content) animate(content, [{ paddingRight: before.gutter }, { paddingRight: gutter }])
      if (tools)
        animate(tools, [
          {
            gridTemplateRows: before.rows,
            opacity: before.toolsOpacity,
            transform: before.toolsTransform ?? (expanded ? "translateY(4px)" : "none"),
          },
          { gridTemplateRows: rows, opacity: expanded ? 1 : 0, transform: expanded ? "none" : "translateY(-3px)" },
        ])
      if (panes && before.columns !== "none" && columns !== "none")
        animate(panes, [{ gridTemplateColumns: before.columns }, { gridTemplateColumns: columns }])
      if (preview)
        animate(preview, [
          {
            opacity: before.previewOpacity,
            transform: before.previewTransform ?? (expanded ? "translateX(6px)" : "none"),
          },
          { opacity: expanded ? 1 : 0, transform: expanded ? "none" : "translateX(4px)" },
        ])
      if (editor) editor.scrollTop = before.scrollTop
      void sizing.finished.then(
        () => {
          if (token === generation) stop(true)
        },
        () => {},
      )
    },
    cancel: () => stop(true),
    dispose() {
      reduced.removeEventListener("change", preference)
      stop(false)
    },
  }
}

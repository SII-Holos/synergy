import { createEffect, createSignal, onCleanup } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { usePixelCanvas } from "../pixels"
import { useSceneClock } from "../clock"
import {
  createBlocks,
  advanceBlocks,
  moveBlocks,
  rotateBlocks,
  dropBlocks,
  startBlocks,
  controlBlocks,
  occupiedCells,
  landingPiece,
} from "./model"

export default function BlocksScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const blockSize = 20
  const boardLeft = 150
  const [state, setState] = createSignal(
    controlBlocks(
      props.memory.read(() => createBlocks(props.seed)),
      { horizontal: 0, soft: false },
    ),
  )
  let touch: { id: number; x: number; y: number; lastX: number; moved: boolean } | undefined
  const keys = new Set<string>()
  createEffect(() => props.memory.write(state()))
  useSceneClock(props.active, (dt) => {
    canvas.advanceTransition(dt)
    setState((s) => advanceBlocks(s, dt))
  })
  const reset = () => {
    cancel()
    keys.clear()
    canvas.transition()
    setState(createBlocks(props.seed))
  }
  const start = () => {
    props.interact()
    if (state().phase === "over") reset()
    setState(startBlocks)
  }
  const status = () =>
    state().phase === "over"
      ? i18n._({ id: "welcome.blocks.over", message: "{score} points · Play again", values: { score: state().score } })
      : !props.active()
        ? i18n._({ id: "welcome.common.continue", message: "Click to continue" })
        : state().phase === "ready"
          ? i18n._({ id: "welcome.blocks.ready", message: "Click to play · ↑ rotate · Space drop" })
          : i18n._({
              id: "welcome.blocks.score",
              message: "{score} points · {lines} lines",
              values: { score: state().score, lines: state().lines },
            })
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state(),
        size = blockSize,
        left = boardLeft,
        top = 16
      const over = s.phase === "over"
      const ending = over ? (props.reducedMotion() ? 1 : s.ending) : 0
      const cell = (x: number, y: number, kind: number, alpha = 1) => {
        if (y < 0) return
        const settle = over ? Math.max(0, Math.min(1, (ending - y * 0.03) / 0.28)) : 0
        alpha *= 1 - settle * 0.75
        const offset = props.reducedMotion() ? 0 : Math.round(settle * settle * 6)
        ctx.globalAlpha = alpha
        ctx.fillStyle = ink.colors[kind % ink.colors.length]!
        ctx.fillRect(left + x * size + 1, top + y * size + 1 + offset, size - 2, size - 2)
        ctx.fillStyle = ink.paper
        ctx.globalAlpha = alpha * 0.5
        ctx.fillRect(left + x * size + 3, top + y * size + 3 + offset, size - 6, 2)
        ctx.fillStyle = ink.strong
        ctx.globalAlpha = alpha * 0.18
        ctx.fillRect(left + x * size + 3, top + y * size + size - 4 + offset, size - 6, 2)
        ctx.globalAlpha = 1
      }
      ctx.fillStyle = ink.strong
      ctx.globalAlpha = 0.1
      for (let y = 0; y <= 20; y++) for (let x = 0; x <= 10; x++) ctx.fillRect(left + x * size, top + y * size, 1, 1)
      ctx.fillRect(left - 5, top + size * 20 + 2, size * 10 + 10, 2)
      ctx.globalAlpha = 1
      s.board.forEach((kind, index) => {
        if (kind) cell(index % 10, Math.floor(index / 10), kind - 1)
      })
      if (!over && s.phase !== "clearing") {
        occupiedCells(landingPiece(s)).forEach((c) => cell(c.x, c.y, s.piece.kind, 0.22))
        occupiedCells(s.piece).forEach((c) => cell(c.x, c.y, s.piece.kind))
      }
      if (!over && s.trail && !props.reducedMotion()) {
        const trail = s.trail
        ctx.fillStyle = ink.colors[trail.piece.kind % ink.colors.length]!
        ctx.globalAlpha = (0.16 * trail.time) / 0.09
        for (const c of occupiedCells(trail.piece)) {
          ctx.fillRect(
            left + c.x * size + 4,
            top + Math.max(0, c.y) * size,
            size - 8,
            (trail.to - trail.piece.y) * size,
          )
        }
        ctx.globalAlpha = 1
      }
      for (let i = 0; i < 3; i++)
        occupiedCells({ kind: s.queue[i]!, rotation: 0, x: 12, y: 2 + i * 5 }).forEach((c) =>
          cell(c.x, c.y, s.queue[i]!, 0.55),
        )
      if (s.flash > 0) {
        ctx.fillStyle = ink.paper
        ctx.globalAlpha = 0.7
        for (const row of s.cleared) ctx.fillRect(left, top + row * size, size * 10, size)
        ctx.fillStyle = ink.accent
        ctx.globalAlpha = 0.8
        for (const row of s.cleared) {
          const width = props.reducedMotion() ? 10 * size : Math.round((1 - s.flash / 0.14) * 10 * size)
          ctx.fillRect(left, top + row * size + size - 2, width, 2)
        }
        ctx.globalAlpha = 1
      }
    },
    520,
    440,
    "center",
    props.reducedMotion,
  )
  const cancel = () => {
    keys.clear()
    setState((s) => controlBlocks(s, { horizontal: 0, soft: false }))
    if (!touch) return
    const id = touch.id
    touch = undefined
    if (canvas.element().hasPointerCapture(id)) canvas.element().releasePointerCapture(id)
  }
  createEffect(() => {
    if (!props.active()) cancel()
  })
  onCleanup(cancel)
  return (
    <div
      class="welcome-game welcome-blocks"
      data-phase={state().phase}
      data-locked={state().board.filter(Boolean).length}
      data-column={state().piece.x}
      data-row={state().piece.y}
      data-lines={state().lines}
      data-rotation={state().piece.rotation}
    >
      <GameSurface
        scene={props}
        name={i18n._({ id: "welcome.blocks.name", message: "Falling blocks" })}
        status={status()}
        playing={state().phase === "playing" || state().phase === "clearing"}
        onAction={start}
        onReset={reset}
        help={i18n._({
          id: "welcome.blocks.help",
          message:
            "Left and right move, Up rotates, Down lowers and Space drops. Hold left or right to repeat. On touch, drag sideways continuously, tap to rotate, and swipe down to drop.",
        })}
        onKey={(e) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(e.key)) return
          e.preventDefault()
          e.stopPropagation()
          props.interact()
          if (e.repeat) return
          if (state().phase === "over") {
            start()
            return
          }
          setState(startBlocks)
          keys.add(e.key)
          if (e.key === "ArrowLeft" || e.key === "ArrowRight")
            setState((s) => controlBlocks(s, { horizontal: e.key === "ArrowLeft" ? -1 : 1 }))
          if (e.key === "ArrowUp") setState(rotateBlocks)
          if (e.key === "ArrowDown") setState((s) => controlBlocks(s, { soft: true }))
          if (e.key === " ") setState(dropBlocks)
          if (e.key === "Enter") start()
        }}
      >
        <canvas
          ref={canvas.ref}
          class="welcome-game-canvas"
          data-welcome-visual
          tabIndex={0}
          role="group"
          aria-label={i18n._({ id: "welcome.blocks.field", message: "Falling-block playfield" })}
          onKeyUp={(e) => {
            keys.delete(e.key)
            if (e.key === "ArrowLeft" || e.key === "ArrowRight")
              setState((s) =>
                controlBlocks(s, { horizontal: keys.has("ArrowRight") ? 1 : keys.has("ArrowLeft") ? -1 : 0 }),
              )
            if (e.key === "ArrowDown") setState((s) => controlBlocks(s, { soft: false }))
          }}
          onBlur={cancel}
          onPointerMove={(e) => {
            if (!props.active()) return
            const point = canvas.point(e)
            if (touch?.id === e.pointerId) {
              const count = Math.trunc((point.x - touch.lastX) / blockSize)
              if (!count) return
              touch.moved = true
              touch.lastX += count * blockSize
              start()
              for (let n = 0; n < Math.min(10, Math.abs(count)); n++) setState((s) => moveBlocks(s, Math.sign(count)))
              return
            }
            if (state().phase !== "ready" || e.pointerType === "touch") return
            const desired = Math.max(0, Math.min(9, Math.floor((point.x - boardLeft) / blockSize) - 1))
            setState((current) => {
              let next = current
              for (let i = 0; i < 10 && next.piece.x !== desired; i++) {
                const moved = moveBlocks(next, desired - next.piece.x)
                if (moved === next) break
                next = moved
              }
              return next
            })
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || touch) return
            canvas.element().focus({ preventScroll: true })
            props.interact()
            const p = canvas.point(e)
            touch = { id: e.pointerId, ...p, lastX: p.x, moved: false }
            canvas.element().setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            if (touch?.id !== e.pointerId) return
            const p = canvas.point(e),
              dx = p.x - touch.x,
              dy = p.y - touch.y,
              moved = touch.moved
            touch = undefined
            canvas.element().releasePointerCapture(e.pointerId)
            if (state().phase === "over") {
              start()
              return
            }
            start()
            if (dy > 28 && dy > Math.abs(dx)) setState(dropBlocks)
            else if (!moved) setState(rotateBlocks)
          }}
          onPointerCancel={(e) => {
            if (touch?.id === e.pointerId) cancel()
          }}
          onLostPointerCapture={(e) => {
            if (touch?.id === e.pointerId) cancel()
          }}
        />
      </GameSurface>
    </div>
  )
}

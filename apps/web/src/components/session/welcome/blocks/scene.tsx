import { createEffect, createSignal } from "solid-js"
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
  descendBlocks,
  occupiedCells,
  landingPiece,
} from "./model"

export default function BlocksScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const blockSize = 20
  const boardLeft = 150
  const [state, setState] = createSignal(props.memory.read(() => createBlocks(props.seed)))
  let touch: { id: number; x: number; y: number } | undefined
  createEffect(() => props.memory.write(state()))
  useSceneClock(props.active, (dt) => setState((s) => advanceBlocks(s, dt)))
  const reset = () => setState(createBlocks(props.seed))
  const start = () => {
    props.interact()
    setState((s) =>
      s.phase === "over" ? { ...createBlocks(props.seed), phase: "playing" } : { ...s, phase: "playing" },
    )
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
      const cell = (x: number, y: number, kind: number, alpha = 1) => {
        if (y < 0) return
        ctx.globalAlpha = alpha
        ctx.fillStyle = ink.colors[kind % ink.colors.length]!
        ctx.fillRect(left + x * size + 1, top + y * size + 1, size - 2, size - 2)
        ctx.fillStyle = ink.paper
        ctx.globalAlpha = alpha * 0.5
        ctx.fillRect(left + x * size + 3, top + y * size + 3, size - 6, 2)
        ctx.fillStyle = ink.strong
        ctx.globalAlpha = alpha * 0.18
        ctx.fillRect(left + x * size + 3, top + y * size + size - 4, size - 6, 2)
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
      occupiedCells(landingPiece(s)).forEach((c) => cell(c.x, c.y, s.piece.kind, 0.12))
      occupiedCells(s.piece).forEach((c) => cell(c.x, c.y, s.piece.kind))
      for (let i = 0; i < 3; i++)
        occupiedCells({ kind: s.queue[i]!, rotation: 0, x: 12, y: 2 + i * 5 }).forEach((c) =>
          cell(c.x, c.y, s.queue[i]!, 0.35),
        )
      if (s.flash > 0) {
        ctx.fillStyle = ink.strong
        ctx.globalAlpha = s.flash * 0.7
        for (const row of s.cleared) ctx.fillRect(left - 10, top + row * size, size * 10 + 20, size)
        ctx.globalAlpha = 1
      }
    },
    520,
    440,
  )
  return (
    <div
      class="welcome-game welcome-blocks"
      data-phase={state().phase}
      data-locked={state().board.filter(Boolean).length}
      data-column={state().piece.x}
    >
      <GameSurface
        scene={props}
        name={i18n._({ id: "welcome.blocks.name", message: "Falling blocks" })}
        status={status()}
        playing={state().phase === "playing"}
        onAction={start}
        onReset={reset}
        help={i18n._({
          id: "welcome.blocks.help",
          message:
            "Left and right move, Up rotates, Down lowers and Space drops. On touch, tap to rotate, swipe sideways to move, and swipe down to drop.",
        })}
        onKey={(e) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(e.key)) return
          e.preventDefault()
          e.stopPropagation()
          props.interact()
          if (state().phase === "over") {
            start()
            return
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight")
            setState((s) => moveBlocks(s, e.key === "ArrowLeft" ? -1 : 1))
          if (e.key === "ArrowUp") setState(rotateBlocks)
          if (e.key === "ArrowDown") setState(descendBlocks)
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
          onPointerMove={(e) => {
            if (!props.active() || state().phase !== "ready" || e.pointerType === "touch") return
            const desired = Math.max(0, Math.min(9, Math.floor((canvas.point(e).x - boardLeft) / blockSize) - 1))
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
            if (e.button !== 0) return
            canvas.element().focus({ preventScroll: true })
            props.interact()
            const p = canvas.point(e)
            touch = { id: e.pointerId, ...p }
            canvas.element().setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            if (touch?.id !== e.pointerId) return
            const p = canvas.point(e),
              dx = p.x - touch.x,
              dy = p.y - touch.y
            touch = undefined
            canvas.element().releasePointerCapture(e.pointerId)
            if (state().phase !== "playing") {
              start()
              return
            }
            if (dy > 28 && dy > Math.abs(dx)) setState(dropBlocks)
            else if (Math.abs(dx) > 18)
              for (let i = 0; i < Math.min(10, Math.round(Math.abs(dx) / blockSize)); i++)
                setState((s) => moveBlocks(s, Math.sign(dx)))
            else setState(rotateBlocks)
          }}
          onPointerCancel={() => {
            touch = undefined
          }}
          onLostPointerCapture={() => {
            touch = undefined
          }}
        />
      </GameSurface>
    </div>
  )
}

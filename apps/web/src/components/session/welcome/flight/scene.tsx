import { createEffect, createSignal, onCleanup } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { sprite, sprites, usePixelCanvas } from "../pixels"
import { useSceneClock } from "../clock"
import { createFlight, aimFlight, startFlight, advanceFlight } from "./model"

const powerSprites = {
  fire: ["0001000", "0011100", "0101010", "1001001", "0001000", "0001000", "0001000"],
  shield: ["1111111", "1222221", "1222221", "0122210", "0122210", "0012100", "0001000"],
  repair: ["0001000", "0001000", "0001000", "1111111", "0001000", "0001000", "0001000"],
}
const armored = [
  "0001111111000",
  "0011111111100",
  "0111222221110",
  "1111222221111",
  "1111111111111",
  "1101111111011",
  "1000111110001",
  "0000010100000",
]
export default function FlightScene(props: WelcomeSceneProps) {
  const { i18n } = useLocale()
  const [state, setState] = createSignal(props.memory.read(() => createFlight(props.seed)))
  const [idle, setIdle] = createSignal(0)
  const keys = new Set<string>()
  let pointer: number | undefined
  createEffect(() => props.memory.write(state()))
  createEffect(() => {
    if (!props.active()) {
      keys.clear()
      cancelPointer()
    }
  })
  const reset = () => {
    keys.clear()
    setState(createFlight(props.seed))
  }
  const start = () => {
    props.interact()
    setState((s) => startFlight(s.phase === "over" ? createFlight(props.seed) : s))
  }
  useSceneClock(props.active, (dt) => {
    if (!props.reducedMotion()) setIdle((t) => t + dt)
    setState((s) =>
      advanceFlight(s, dt, {
        x: (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0),
        y: (keys.has("ArrowDown") ? 1 : 0) - (keys.has("ArrowUp") ? 1 : 0),
      }),
    )
  })
  const status = () =>
    state().phase === "over"
      ? i18n._({ id: "welcome.flight.over", message: "{score} points · Fly again", values: { score: state().score } })
      : !props.active()
        ? i18n._({ id: "welcome.common.continue", message: "Click to continue" })
        : state().phase === "ready"
          ? i18n._({ id: "welcome.flight.ready", message: "Move to steer · Click to fly" })
          : `${String(state().score).padStart(4, "0")} · ${"♥".repeat(state().lives)}${state().fire > 0 ? ` · ↟ ${Math.ceil(state().fire)}` : ""}${state().shield > 0 ? ` · ◇ ${Math.ceil(state().shield)}` : ""}`
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state(),
        time = idle()
      s.bullets.forEach((b) => {
        ctx.fillStyle = ink.strong
        ctx.fillRect(Math.round(b.x), Math.round(b.y), 2, 9)
        ctx.fillStyle = ink.second
        ctx.fillRect(Math.round(b.x), Math.round(b.y) + 7, 2, 3)
      })
      s.enemies.forEach((e) => {
        const mask = e.kind === 2 ? armored : e.kind === 1 ? sprites.drone : sprites.enemy
        sprite(ctx, mask, e.x - mask[0]!.length, e.y - 8, 2, e.kind === 2 ? ink.second : ink.strong, ink.paper)
        if (e.hp > 1) {
          ctx.fillStyle = ink.accent
          for (let n = 0; n < e.hp; n++) ctx.fillRect(Math.round(e.x) - e.hp * 3 + n * 6, Math.round(e.y) + 11, 4, 2)
        }
        if (e.flash > 0 && !props.reducedMotion()) {
          ctx.globalAlpha = (e.flash / 0.09) * 0.65
          ctx.fillStyle = ink.paper
          ctx.fillRect(Math.round(e.x) - 5, Math.round(e.y) - 3, 10, 6)
          ctx.globalAlpha = 1
        }
      })
      s.pickups.forEach((p) => {
        const offset = props.reducedMotion() ? 0 : Math.sin(s.time * 3 + p.id) * 2
        const color = p.kind === "fire" ? ink.second : p.kind === "shield" ? ink.accent : ink.colors[2]!
        sprite(ctx, powerSprites[p.kind], p.x - 10, p.y - 10 + offset, 3, color, ink.paper)
      })
      if (!props.reducedMotion())
        s.bursts.forEach((b) => {
          ctx.fillStyle =
            b.kind === "hurt" ? ink.strong : b.kind === "pickup" || b.kind === "shield" ? ink.accent : ink.second
          ctx.globalAlpha = Math.max(0, 1 - b.age / 0.6)
          if (b.age < 0.09 && b.kind === "destroy") ctx.fillRect(Math.round(b.x) - 5, Math.round(b.y) - 5, 10, 10)
          const count = b.kind === "hit" ? 4 : 10
          for (let i = 0; i < count; i++) {
            const a = (i * Math.PI * 2) / count,
              r = 5 + b.age * (b.kind === "destroy" ? 65 : 36)
            const size = b.age < 0.2 ? 4 : 2
            ctx.fillRect(Math.round(b.x + Math.cos(a) * r), Math.round(b.y + Math.sin(a) * r), size, size)
          }
          if (b.points && b.age > 0.1) {
            ctx.font = "10px monospace"
            ctx.textAlign = "center"
            ctx.fillText(`+${b.points}`, Math.round(b.x), Math.round(b.y - b.age * 30 - 14))
          }
          ctx.globalAlpha = 1
        })
      if (s.shield > 0 || s.invulnerable > 0) {
        ctx.strokeStyle = s.shield > 0 ? ink.accent : ink.soft
        ctx.lineWidth = 2
        ctx.globalAlpha = 0.65
        ctx.beginPath()
        for (let n = 0; n <= 8; n++) {
          const a = (n * Math.PI) / 4,
            x = Math.round(s.ship.x + Math.cos(a) * 24),
            y = Math.round(s.ship.y + Math.sin(a) * 24)
          if (!n) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = s.invulnerable > 0 ? 0.65 : 1
      sprite(ctx, sprites.ship, s.ship.x - 11, s.ship.y - 11, 2, ink.strong, ink.paper)
      ctx.globalAlpha = 0.65
      ctx.fillStyle = ink.second
      const exhaust = props.reducedMotion() ? 4 : 4 + (Math.floor(time * 9) % 3) * 2
      ctx.fillRect(s.ship.x - 8, s.ship.y + 9, 4, exhaust)
      ctx.fillRect(s.ship.x + 4, s.ship.y + 9, 4, exhaust)
      ctx.globalAlpha = 1
      if (s.muzzle > 0 && !props.reducedMotion()) {
        ctx.fillStyle = ink.second
        ctx.fillRect(Math.round(s.ship.x) - 3, Math.round(s.ship.y) - 23, 6, 5)
      }
    },
    720,
    400,
  )
  function cancelPointer() {
    if (pointer === undefined) return
    const id = pointer
    pointer = undefined
    if (canvas.element().hasPointerCapture(id)) canvas.element().releasePointerCapture(id)
  }
  onCleanup(() => {
    keys.clear()
    cancelPointer()
  })
  return (
    <div
      class="welcome-game welcome-flight"
      data-phase={state().phase}
      data-lives={state().lives}
      data-kills={state().kills}
      data-fire={state().fire > 0}
      data-shield={state().shield > 0}
    >
      <GameSurface
        scene={props}
        name={i18n._({ id: "welcome.flight.name", message: "Pixel squadron" })}
        status={status()}
        playing={state().phase === "playing"}
        onAction={start}
        onReset={reset}
        help={i18n._({
          id: "welcome.flight.help",
          message:
            "Move the pointer or use arrow keys to steer. Click or press Space to start automatic fire. Avoid collisions; missed enemies break your combo. Collect arrows for ten seconds of firepower, a shield for one protected hit, or a cross to repair.",
        })}
        onKey={(e) => {
          if (e.key.startsWith("Arrow")) {
            e.preventDefault()
            e.stopPropagation()
            props.interact()
            keys.add(e.key)
            setState(startFlight)
          }
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault()
            e.stopPropagation()
            start()
          }
        }}
      >
        <canvas
          ref={canvas.ref}
          class="welcome-game-canvas"
          data-welcome-visual
          tabIndex={0}
          role="group"
          aria-label={i18n._({ id: "welcome.flight.field", message: "Aircraft playfield" })}
          aria-description={i18n._({
            id: "welcome.flight.position",
            message: "Aircraft at {x}, {y}",
            values: { x: Math.round(state().ship.x), y: Math.round(state().ship.y) },
          })}
          onKeyUp={(e) => keys.delete(e.key)}
          onBlur={() => keys.clear()}
          onPointerMove={(e) => {
            if (props.active()) {
              const p = canvas.point(e)
              setState((s) => aimFlight(s, p.x, p.y))
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            canvas.element().focus({ preventScroll: true })
            start()
            const p = canvas.point(e)
            setState((s) => aimFlight(s, p.x, p.y))
            pointer = e.pointerId
            canvas.element().setPointerCapture(e.pointerId)
          }}
          onPointerUp={cancelPointer}
          onLostPointerCapture={cancelPointer}
          onPointerCancel={() => {
            cancelPointer()
            props.pause()
          }}
        />
      </GameSurface>
    </div>
  )
}

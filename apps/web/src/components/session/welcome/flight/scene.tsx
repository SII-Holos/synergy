import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useLocale } from "@/context/locale"
import type { WelcomeSceneProps } from "../types"
import { GameSurface } from "../surface"
import { sprite, sprites, usePixelCanvas } from "../pixels"
import { useSceneClock } from "../clock"
import { createFlight, aimFlight, startFlight, advanceFlight } from "./model"

const powerSprites = {
  fire: [
    "0000033300000",
    "0000311130000",
    "0030312130300",
    "0313312133130",
    "0311312131130",
    "0312312132130",
    "0312312132130",
    "0312312132130",
    "0311311131130",
    "0333333333330",
    "0311133311130",
    "0333300033330",
  ],
  shield: [
    "0000333330000",
    "0033112113300",
    "0310000000130",
    "3100003000013",
    "3100033300013",
    "3103032303013",
    "3103332333013",
    "3103333333013",
    "3103033303013",
    "0310030300130",
    "0031100013300",
    "0003333333000",
  ],
  repair: [
    "0000333330000",
    "0003100013000",
    "0333333333330",
    "3111111111113",
    "3112211221113",
    "3122222222113",
    "3122222222113",
    "3112222221113",
    "3111222211113",
    "3111122111113",
    "3111111111113",
    "0333333333330",
  ],
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
    cancelPointer()
    canvas.transition()
    setState(createFlight(props.seed))
  }
  const start = () => {
    props.interact()
    if (state().phase === "over") reset()
    setState(startFlight)
  }
  useSceneClock(props.active, (dt) => {
    canvas.advanceTransition(dt)
    if (!props.reducedMotion() && state().phase !== "over") setIdle((t) => t + dt)
    setState((s) =>
      advanceFlight(s, dt, {
        x: (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0),
        y: (keys.has("ArrowDown") ? 1 : 0) - (keys.has("ArrowUp") ? 1 : 0),
      }),
    )
  })
  const pickupNames = createMemo(() => ({
    fire: i18n._({ id: "welcome.flight.pickup.fire", message: "Triple shot" }),
    shield: i18n._({ id: "welcome.flight.pickup.shield", message: "Barrier" }),
    repair: i18n._({ id: "welcome.flight.pickup.repair", message: "Repair" }),
  }))
  const notice = createMemo(() => {
    const n = state().notice
    if (!n) return ""
    if (n.kind === "fire") return i18n._({ id: "welcome.flight.received.fire", message: "Triple fire · 10 seconds" })
    if (n.kind === "shield")
      return i18n._({ id: "welcome.flight.received.shield", message: "One-hit protection · 8 seconds" })
    if (n.points)
      return i18n._({
        id: "welcome.flight.received.bonus",
        message: "Full health · +{points}",
        values: { points: n.points },
      })
    return i18n._({ id: "welcome.flight.received.repair", message: "Health +1" })
  })
  const status = () => {
    const s = state()
    if (s.phase === "over")
      return i18n._({ id: "welcome.flight.over", message: "{score} points · Fly again", values: { score: s.score } })
    if (!props.active()) return i18n._({ id: "welcome.common.continue", message: "Click to continue" })
    if (s.phase === "ready") return i18n._({ id: "welcome.flight.ready", message: "Move to steer · Click to fly" })
    return [
      String(s.score).padStart(4, "0"),
      "♥".repeat(s.lives),
      s.fire > 0 &&
        i18n._({
          id: "welcome.flight.effect.fire",
          message: "Firepower {seconds}s",
          values: { seconds: Math.ceil(s.fire) },
        }),
      s.shield > 0 &&
        i18n._({
          id: "welcome.flight.effect.shield",
          message: "Shield {seconds}s",
          values: { seconds: Math.ceil(s.shield) },
        }),
    ]
      .filter(Boolean)
      .join(" · ")
  }
  const canvas = usePixelCanvas(
    (ctx, ink) => {
      const s = state(),
        time = idle()
      const over = s.phase === "over"
      const ending = over ? (props.reducedMotion() ? 1 : s.ending) : 0
      ctx.globalAlpha = (1 - ending) ** 2
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
        if (!over && e.flash > 0 && !props.reducedMotion()) {
          ctx.globalAlpha = (e.flash / 0.09) * 0.65
          ctx.fillStyle = ink.paper
          ctx.fillRect(Math.round(e.x) - 5, Math.round(e.y) - 3, 10, 6)
          ctx.globalAlpha = 1
        }
      })
      s.pickups.forEach((p) => {
        const offset = props.reducedMotion() ? 0 : Math.sin(s.time * 3 + p.id) * 2
        const color = p.kind === "fire" ? ink.second : p.kind === "shield" ? ink.accent : ink.colors[2]!
        sprite(ctx, powerSprites[p.kind], p.x - 13, p.y - 12 + offset, 2, color, ink.paper, ink.strong)
        if (!over && Math.hypot(p.x - s.ship.x, p.y - s.ship.y) < 130) {
          ctx.fillStyle = ink.strong
          ctx.font = "10px sans-serif"
          ctx.textAlign = "center"
          const label = pickupNames()[p.kind]
          const half = ctx.measureText(label).width / 2 + 4
          ctx.fillText(
            label,
            Math.round(Math.max(half, Math.min(720 - half, p.x))),
            Math.round(p.y + (p.y > 360 ? -18 : 24) + offset),
          )
        }
      })
      ctx.globalAlpha = 1
      if (over) {
        if (!props.reducedMotion() && ending < 0.8) {
          const t = ending / 0.8
          ctx.globalAlpha = (1 - t) ** 2
          for (let i = 0; i < 16; i++) {
            const a = (i * Math.PI) / 8
            const distance = (1 - (1 - t) ** 3) * (22 + (i % 3) * 12)
            ctx.fillStyle = i % 3 ? ink.strong : ink.second
            ctx.fillRect(
              Math.round(s.ship.x + Math.cos(a) * distance),
              Math.round(s.ship.y + Math.sin(a) * distance + 30 * t * t),
              i % 2 ? 3 : 5,
              i % 2 ? 5 : 3,
            )
          }
          if (ending < 0.35) {
            ctx.fillStyle = ink.second
            const radius = 8 + 55 * (1 - (1 - ending / 0.35) ** 3)
            for (let i = 0; i < 24; i++) {
              const angle = (i * Math.PI) / 12
              ctx.fillRect(
                Math.round((s.ship.x + Math.cos(angle) * radius) / 2) * 2,
                Math.round((s.ship.y + Math.sin(angle) * radius) / 2) * 2,
                2,
                2,
              )
            }
          }
        }
        const ready = Math.max(0, Math.min(1, (ending - 0.45) / 0.55))
        ctx.globalAlpha = ready * 0.35
        sprite(ctx, sprites.ship, 349, 319 + Math.round(8 * (1 - ready) ** 3), 2, ink.strong, ink.paper)
        ctx.globalAlpha = 1
        return
      }
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
      if (s.notice) {
        const label = notice()
        ctx.font = "11px sans-serif"
        ctx.textAlign = "center"
        const width = ctx.measureText(label).width + 12
        const x = Math.round(Math.max(width / 2 + 4, Math.min(716 - width / 2, s.ship.x)))
        const y = Math.round(s.ship.y - 40 - (props.reducedMotion() ? 0 : Math.min(s.notice.age, 0.3) * 20))
        ctx.globalAlpha = props.reducedMotion() ? 1 : Math.min(1, (1.4 - s.notice.age) / 0.3)
        ctx.fillStyle = ink.paper
        ctx.fillRect(x - width / 2, y - 12, width, 18)
        ctx.fillStyle = ink.strong
        ctx.fillText(label, x, y)
        ctx.globalAlpha = 1
      }
    },
    720,
    400,
    "center",
    props.reducedMotion,
  )
  function cancelPointer(event?: PointerEvent) {
    if (event && event.pointerId !== pointer) return
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
      <span class="sr-only" role="status">
        {notice()}
      </span>
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
            "Move the pointer or use arrow keys to steer. Click or press Space to start automatic fire. Avoid collisions; missed enemies break your combo. Collect ammunition for ten seconds of triple fire, a bubble for one protected hit, or a heart supply box to repair.",
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
            if (e.repeat) return
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
            if (pointer !== undefined && pointer !== e.pointerId) return
            if (props.active()) {
              const p = canvas.point(e)
              setState((s) => aimFlight(s, p.x, p.y))
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || pointer !== undefined) return
            canvas.element().focus({ preventScroll: true })
            start()
            const p = canvas.point(e)
            setState((s) => aimFlight(s, p.x, p.y))
            pointer = e.pointerId
            canvas.element().setPointerCapture(e.pointerId)
          }}
          onPointerUp={cancelPointer}
          onLostPointerCapture={cancelPointer}
          onPointerCancel={(e) => {
            if (pointer !== e.pointerId) return
            cancelPointer()
            props.pause()
          }}
        />
      </GameSurface>
    </div>
  )
}

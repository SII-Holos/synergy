import { createSignal, onMount, onCleanup, Show } from "solid-js"
import { Mark } from "@ericsanchezok/synergy-ui/logo"

interface IntroSequenceProps {
  onPreload?: () => void
  onComplete: () => void
}

const EASE_IN = "opacity 800ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 800ms cubic-bezier(0.2, 0.8, 0.2, 1)"
const EASE_OUT = "opacity 600ms cubic-bezier(0.4, 0.0, 0.2, 1), transform 600ms cubic-bezier(0.4, 0.0, 0.2, 1)"

const PANEL_1_HOLD = 1200
const PANEL_1_FADE_OUT = 600
const GAP = 400
const PANEL_2_HOLD = 1400
const PANEL_2_FADE_OUT = 600

export function IntroSequence(props: IntroSequenceProps) {
  const [panel, setPanel] = createSignal<1 | 2>(1)

  const [panel1Style, setPanel1Style] = createSignal({
    opacity: 0,
    transform: "translateY(8px)",
    transition: EASE_IN,
  })

  const [panel2LogoStyle, setPanel2LogoStyle] = createSignal({
    opacity: 0,
    transform: "translateY(6px)",
    transition: EASE_IN,
  })

  const [panel2TextStyle, setPanel2TextStyle] = createSignal({
    opacity: 0,
    transform: "translateY(8px)",
    transition: EASE_IN,
  })

  onMount(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const t = (fn: () => void, ms: number) => {
      timers.push(setTimeout(fn, ms))
    }

    let elapsed = 0

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setPanel1Style({
          opacity: 1,
          transform: "translateY(0)",
          transition: EASE_IN,
        })
      })
    })

    elapsed += 800 + PANEL_1_HOLD
    t(() => {
      setPanel1Style({
        opacity: 0,
        transform: "translateY(-4px)",
        transition: EASE_OUT,
      })
    }, elapsed)

    elapsed += PANEL_1_FADE_OUT + GAP
    t(() => {
      setPanel(2)
      props.onPreload?.()
    }, elapsed)

    const panel2Start = elapsed
    t(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPanel2LogoStyle({
            opacity: 1,
            transform: "translateY(0)",
            transition: EASE_IN,
          })
        })
      })
    }, panel2Start)

    t(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPanel2TextStyle({
            opacity: 1,
            transform: "translateY(0)",
            transition: EASE_IN,
          })
        })
      })
    }, panel2Start + 200)

    elapsed = panel2Start + 800 + PANEL_2_HOLD
    t(() => {
      setPanel2LogoStyle({
        opacity: 0,
        transform: "translateY(-4px)",
        transition: EASE_OUT,
      })
      setPanel2TextStyle({
        opacity: 0,
        transform: "translateY(-4px)",
        transition: EASE_OUT,
      })
    }, elapsed)

    elapsed += PANEL_2_FADE_OUT
    t(() => {
      props.onComplete()
    }, elapsed)

    onCleanup(() => {
      for (const timer of timers) clearTimeout(timer)
    })
  })

  return (
    <div class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background-base select-none cursor-default">
      <Show when={panel() === 1}>
        <div style={panel1Style()} class="flex flex-col items-center">
          <span
            class="text-text-strong font-light tracking-tight leading-none"
            style={{ "font-size": "clamp(48px, 7vw, 72px)" }}
          >
            Hi
          </span>
        </div>
      </Show>

      <Show when={panel() === 2}>
        <div class="flex flex-col items-center gap-5">
          <div style={panel2LogoStyle()}>
            <Mark class="!size-12 !rounded-[12px]" />
          </div>
          <div style={panel2TextStyle()}>
            <span
              class="text-text-strong font-medium tracking-tight leading-none"
              style={{ "font-size": "clamp(32px, 5vw, 48px)" }}
            >
              I'm Synergy
            </span>
          </div>
        </div>
      </Show>
    </div>
  )
}

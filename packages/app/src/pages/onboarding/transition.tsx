import { createSignal, onMount, onCleanup, Show } from "solid-js"

interface PhaseTransitionProps {
  text: string
  subtitle?: string
  onMidpoint?: () => void
  onComplete: () => void
}

export function PhaseTransition(props: PhaseTransitionProps) {
  const [style, setStyle] = createSignal({
    opacity: 0,
    transform: "translateY(8px)",
    transition: "opacity 600ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1)",
  })

  onMount(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setStyle({
          opacity: 1,
          transform: "translateY(0)",
          transition: "opacity 600ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        })
      })
    })

    const fadeOutTimer = setTimeout(() => {
      props.onMidpoint?.()
      setStyle({
        opacity: 0,
        transform: "translateY(-4px)",
        transition: "opacity 600ms cubic-bezier(0.4, 0.0, 0.2, 1), transform 600ms cubic-bezier(0.4, 0.0, 0.2, 1)",
      })
    }, 1800)

    const completeTimer = setTimeout(() => {
      props.onComplete()
    }, 2400)

    onCleanup(() => {
      clearTimeout(fadeOutTimer)
      clearTimeout(completeTimer)
    })
  })

  return (
    <div class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background-base select-none cursor-default">
      <div style={style()} class="flex flex-col items-center max-w-lg px-8">
        <div class="text-text-strong text-[28px] font-medium tracking-tight text-center leading-tight">
          {props.text}
        </div>
        <Show when={props.subtitle}>
          <div class="text-text-weak text-[15px] font-normal mt-3 text-center leading-snug opacity-90">
            {props.subtitle}
          </div>
        </Show>
      </div>
    </div>
  )
}

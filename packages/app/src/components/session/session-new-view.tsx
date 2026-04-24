import { onCleanup, createSignal } from "solid-js"

const SII_LOGO_DATA_URI =
  "data:image/png;base64,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"

const GREETINGS_MORNING = [
  "Rise and ship",
  "Fresh start, fresh code",
  "Morning momentum",
  "Early bird, early merge",
  "Coffee loaded, ready to build",
]

const GREETINGS_AFTERNOON = [
  "Afternoon flow state",
  "Keep the momentum going",
  "Deep work hours",
  "Building something great",
  "Let's ship it",
]

const GREETINGS_EVENING = [
  "Evening coding session",
  "Night owl mode",
  "Quiet hours, deep focus",
  "One more thing before bed",
  "Late night inspiration",
]

const SUBTITLES = [
  "What are we building today?",
  "Need a breakthrough? Let's brainstorm.",
  "Write, debug, ship. Repeat.",
  "Ask anything. I'll figure it out.",
  "What's on your mind?",
  "Ready when you are.",
  "Let's make something happen.",
  "Bugs to squash? Features to build?",
  "Drop some context, let's go.",
]

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function getTimeGreeting(): string {
  const hour = new Date().getHours()
  const pool = hour < 12 ? GREETINGS_MORNING : hour < 18 ? GREETINGS_AFTERNOON : GREETINGS_EVENING
  return pool[Math.floor(Math.random() * pool.length)]
}

function getSubtitle(): string {
  return SUBTITLES[Math.floor(Math.random() * SUBTITLES.length)]
}

export function NewSessionGreeting() {
  const [clock, setClock] = createSignal(formatTime(new Date()))
  const [greeting] = createSignal(getTimeGreeting())
  const [subtitle, setSubtitle] = createSignal(getSubtitle())
  const [transitioning, setTransitioning] = createSignal(false)

  const clockInterval = setInterval(() => setClock(formatTime(new Date())), 1000)
  onCleanup(() => clearInterval(clockInterval))

  const subtitleInterval = setInterval(() => {
    setTransitioning(true)
    setTimeout(() => {
      setSubtitle(getSubtitle())
      setTransitioning(false)
    }, 300)
  }, 8000)
  onCleanup(() => clearInterval(subtitleInterval))

  return (
    <>
      <span class="flex items-center mb-2" style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) both" }}>
        <a
          href="https://www.sii.edu.cn"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:opacity-70 transition-opacity"
        >
          <img src={SII_LOGO_DATA_URI} style={{ height: "30px" }} alt="Shanghai Innovation Institute" />
        </a>
      </span>
      <h1
        class="text-36-medium text-text-strong"
        style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both" }}
      >
        {greeting()}
      </h1>
      <p
        classList={{
          "text-16-medium text-text-weak transition-opacity duration-300 w-full flex items-center gap-2.5": true,
          "opacity-0": transitioning(),
          "opacity-100": !transitioning(),
        }}
        style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both" }}
      >
        <span>{subtitle()}</span>
        <span class="text-text-weaker">·</span>
        <span class="tabular-nums">{clock()}</span>
      </p>
    </>
  )
}

export function NewSessionView() {
  return (
    <div class="size-full flex items-center justify-center">
      <div
        class="flex flex-col items-center gap-4 text-center pointer-events-none select-none"
        style={{ animation: "greetFadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) both" }}
      >
        <a
          href="https://www.sii.edu.cn"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 text-text-subtle hover:opacity-70 transition-opacity pointer-events-auto"
          style={{ animation: "greetFadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) both" }}
        >
          <img src={SII_LOGO_DATA_URI} height="20" alt="Shanghai Innovation Institute" />
          <span class="text-12-regular">Shanghai Innovation Institute</span>
        </a>
        <NewSessionGreeting />
      </div>
    </div>
  )
}

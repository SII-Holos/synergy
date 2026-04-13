import { onCleanup, createSignal } from "solid-js"

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

function getTimeGreeting(): string {
  const hour = new Date().getHours()
  const pool = hour < 12 ? GREETINGS_MORNING : hour < 18 ? GREETINGS_AFTERNOON : GREETINGS_EVENING
  return pool[Math.floor(Math.random() * pool.length)]
}

function getSubtitle(): string {
  return SUBTITLES[Math.floor(Math.random() * SUBTITLES.length)]
}

export function NewSessionGreeting() {
  const [greeting] = createSignal(getTimeGreeting())
  const [subtitle, setSubtitle] = createSignal(getSubtitle())
  const [transitioning, setTransitioning] = createSignal(false)

  const interval = setInterval(() => {
    setTransitioning(true)
    setTimeout(() => {
      setSubtitle(getSubtitle())
      setTransitioning(false)
    }, 300)
  }, 8000)
  onCleanup(() => clearInterval(interval))

  return (
    <>
      <a
        href="https://www.sii.edu.cn"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-2 text-text-subtle hover:opacity-70 transition-opacity pointer-events-auto mb-2"
        style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) both" }}
      >
        <img src="/sii-logo.png" style={{ height: "30px" }} alt="Shanghai Innovation Institute" />
      </a>
      <h1
        class="text-36-medium text-text-strong"
        style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both" }}
      >
        {greeting()}
      </h1>
      <p
        classList={{
          "text-16-medium text-text-weak transition-opacity duration-300": true,
          "opacity-0": transitioning(),
          "opacity-100": !transitioning(),
        }}
        style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both" }}
      >
        {subtitle()}
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
          <img src="/sii-logo.png" height="20" alt="Shanghai Innovation Institute" />
          <span class="text-12-regular">Shanghai Innovation Institute</span>
        </a>
        <NewSessionGreeting />
      </div>
    </div>
  )
}

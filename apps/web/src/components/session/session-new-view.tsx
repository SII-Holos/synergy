import { translateDescriptor } from "@/locales/translate"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useLocale, type IntlFormatter } from "@/context/locale"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import { sharedSecondTick } from "./second-tick"

const GREETINGS_MORNING = [
  { id: "session.greeting.riseAndShip", message: "Rise and ship" },
  { id: "session.greeting.freshStartFreshCode", message: "Fresh start, fresh code" },
  { id: "session.greeting.morningMomentum", message: "Morning momentum" },
  { id: "session.greeting.earlyBirdEarlyMerge", message: "Early bird, early merge" },
  { id: "session.greeting.coffeeLoadedReadyToBuild", message: "Coffee loaded, ready to build" },
]

const GREETINGS_AFTERNOON = [
  { id: "session.greeting.afternoonFlowState", message: "Afternoon flow state" },
  { id: "session.greeting.keepTheMomentumGoing", message: "Keep the momentum going" },
  { id: "session.greeting.deepWorkHours", message: "Deep work hours" },
  { id: "session.greeting.buildingSomethingGreat", message: "Building something great" },
  { id: "session.greeting.letSShipIt", message: "Let's ship it" },
]

const GREETINGS_EVENING = [
  { id: "session.greeting.eveningCodingSession", message: "Evening coding session" },
  { id: "session.greeting.nightOwlMode", message: "Night owl mode" },
  { id: "session.greeting.quietHoursDeepFocus", message: "Quiet hours, deep focus" },
  { id: "session.greeting.oneMoreThingBeforeBed", message: "One more thing before bed" },
  { id: "session.greeting.lateNightInspiration", message: "Late night inspiration" },
]

const SUBTITLES = [
  { id: "session.greeting.whatAreWeBuildingToday", message: "What are we building today?" },
  { id: "session.greeting.needABreakthroughLetSBrainstorm", message: "Need a breakthrough? Let's brainstorm." },
  { id: "session.greeting.writeDebugShipRepeat", message: "Write, debug, ship. Repeat." },
  { id: "session.greeting.askAnythingILlFigureItOut", message: "Ask anything. I'll figure it out." },
  { id: "session.greeting.whatSOnYourMind", message: "What's on your mind?" },
  { id: "session.greeting.readyWhenYouAre", message: "Ready when you are." },
  { id: "session.greeting.letSMakeSomethingHappen", message: "Let's make something happen." },
  { id: "session.greeting.bugsToSquashFeaturesToBuild", message: "Bugs to squash? Features to build?" },
  { id: "session.greeting.dropSomeContextLetSGo", message: "Drop some context, let's go." },
]

function formatTime(date: Date, fmt: IntlFormatter): string {
  return fmt.date(date, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function getTimeGreeting() {
  const hour = new Date().getHours()
  const pool = hour < 12 ? GREETINGS_MORNING : hour < 18 ? GREETINGS_AFTERNOON : GREETINGS_EVENING
  return pool[Math.floor(Math.random() * pool.length)]
}

function getSubtitle() {
  return SUBTITLES[Math.floor(Math.random() * SUBTITLES.length)]
}

export function NewSessionGreeting() {
  const { fmt, i18n } = useLocale()
  const secondTick = sharedSecondTick()
  // The live clock subscribes to the shared 1 Hz source, which pauses while
  // the document is hidden, so the greeting stops ticking in the background.
  createEffect(() => {
    const unsubscribe = secondTick.subscribe()
    onCleanup(unsubscribe)
  })
  const clock = createMemo(() => {
    secondTick.read()
    return formatTime(new Date(), fmt)
  })
  const [greeting] = createSignal(getTimeGreeting())
  const [subtitle, setSubtitle] = createSignal(getSubtitle())
  const [transitioning, setTransitioning] = createSignal(false)

  const subtitleInterval = setInterval(() => {
    if (document.visibilityState === "hidden") return
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
          href={BRAND_ASSETS.sii.url}
          target="_blank"
          rel="noopener noreferrer"
          class="hover:opacity-70 transition-opacity"
        >
          <img src={brandAssetPath(BRAND_ASSETS.sii.logo)} style={{ height: "30px" }} alt={BRAND_ASSETS.sii.name} />
        </a>
      </span>
      <h1
        class="text-36-medium text-text-strong"
        style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both" }}
      >
        {translateDescriptor(greeting(), i18n)}
      </h1>
      <p
        classList={{
          "text-16-medium text-text-weak transition-opacity duration-300 w-full flex items-center gap-2.5": true,
          "opacity-0": transitioning(),
          "opacity-100": !transitioning(),
        }}
        style={{ animation: "greetFadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both" }}
      >
        <span>{translateDescriptor(subtitle(), i18n)}</span>
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
          href={BRAND_ASSETS.sii.url}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 text-text-subtle hover:opacity-70 transition-opacity pointer-events-auto"
          style={{ animation: "greetFadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) both" }}
        >
          <img src={brandAssetPath(BRAND_ASSETS.sii.logo)} height="20" alt={BRAND_ASSETS.sii.name} />
          <span class="text-12-regular">{BRAND_ASSETS.sii.name}</span>
        </a>
        <NewSessionGreeting />
      </div>
    </div>
  )
}

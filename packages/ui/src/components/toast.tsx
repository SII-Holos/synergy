import { Toast as Kobalte, toaster } from "@kobalte/core/toast"
import type { ToastRootProps, ToastCloseButtonProps, ToastTitleProps, ToastDescriptionProps } from "@kobalte/core/toast"
import type { ComponentProps, JSX } from "solid-js"
import { createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon, type IconName } from "./icon"

export interface ToastRegionProps extends ComponentProps<typeof Kobalte.Region> {}

function ToastRegion(props: ToastRegionProps) {
  return (
    <Portal>
      <Kobalte.Region data-component="toast-region" {...props}>
        <Kobalte.List data-slot="toast-list" />
      </Kobalte.Region>
    </Portal>
  )
}

export interface ToastRootComponentProps extends ToastRootProps {
  class?: string
  classList?: ComponentProps<"li">["classList"]
  children?: JSX.Element
  onPointerEnter?: ComponentProps<"li">["onPointerEnter"]
  onPointerLeave?: ComponentProps<"li">["onPointerLeave"]
  onFocusIn?: ComponentProps<"li">["onFocusIn"]
  onFocusOut?: ComponentProps<"li">["onFocusOut"]
}

function ToastRoot(props: ToastRootComponentProps) {
  return (
    <Kobalte
      data-component="toast"
      classList={{
        ...(props.classList ?? {}),
        [props.class ?? ""]: !!props.class,
      }}
      {...props}
    />
  )
}

function ToastIcon(props: { name: IconName }) {
  return (
    <div data-slot="toast-icon">
      <Icon name={props.name} />
    </div>
  )
}

function ToastContent(props: ComponentProps<"div">) {
  return <div data-slot="toast-content" {...props} />
}

function ToastTitle(props: ToastTitleProps & ComponentProps<"div">) {
  return <Kobalte.Title data-slot="toast-title" {...props} />
}

function ToastDescription(props: ToastDescriptionProps & ComponentProps<"div">) {
  return <Kobalte.Description data-slot="toast-description" {...props} />
}

function ToastActions(props: ComponentProps<"div">) {
  return <div data-slot="toast-actions" {...props} />
}

function ToastCloseButton(props: ToastCloseButtonProps & ComponentProps<"button">) {
  return (
    <Kobalte.CloseButton data-slot="toast-close-button" data-component="icon-button" data-variant="ghost" {...props}>
      <Icon name="x" size="small" />
    </Kobalte.CloseButton>
  )
}

function ToastCopyButton(props: ComponentProps<"button"> & { copied?: boolean }) {
  return (
    <button data-slot="toast-copy-button" data-component="icon-button" data-variant="ghost" {...props}>
      <Icon name={props.copied ? "clipboard-check" : "copy"} size="small" />
    </button>
  )
}

function ToastProgressTrack(props: ComponentProps<typeof Kobalte.ProgressTrack>) {
  return <Kobalte.ProgressTrack data-slot="toast-progress-track" {...props} />
}

function ToastProgressFill(props: ComponentProps<typeof Kobalte.ProgressFill>) {
  return <Kobalte.ProgressFill data-slot="toast-progress-fill" {...props} />
}

export const Toast = Object.assign(ToastRoot, {
  Region: ToastRegion,
  Icon: ToastIcon,
  Content: ToastContent,
  Title: ToastTitle,
  Description: ToastDescription,
  Actions: ToastActions,
  CloseButton: ToastCloseButton,
  CopyButton: ToastCopyButton,
  ProgressTrack: ToastProgressTrack,
  ProgressFill: ToastProgressFill,
})

export { toaster }

export type ToastType = "info" | "success" | "warning" | "error"
export const DEFAULT_TOAST_DURATION_MS = 4000

export interface ToastAction {
  label: string
  onClick: "dismiss" | (() => void)
}
export interface ToastConfig {
  muted?: ToastType[]
  durationOverrides?: Partial<Record<ToastType, number>>
}

let toastConfig: ToastConfig | undefined

export function setToastConfig(config: ToastConfig | undefined) {
  toastConfig = config
}

export interface ToastOptions {
  type?: ToastType
  title?: string
  description?: string
  icon?: IconName
  duration?: number
  persistent?: boolean
  actions?: ToastAction[]
}

function defaultIconForType(type: ToastType): IconName | undefined {
  switch (type) {
    case "success":
      return "circle-check"
    case "warning":
      return "alert-triangle"
    case "error":
      return "circle-x"
    default:
      return undefined
  }
}

export function showToast(options: ToastOptions): number {
  const type = options.type ?? "info"

  if (toastConfig?.muted?.includes(type)) return 0

  const resolvedDuration = options.duration ?? toastConfig?.durationOverrides?.[type]
  const iconName = options.icon ?? defaultIconForType(type)
  return toaster.show((props) => {
    const [countdown, setCountdown] = createSignal("")
    const duration = resolvedDuration ?? DEFAULT_TOAST_DURATION_MS
    const hasCountdown = !options.persistent && duration !== 0

    const COUNTDOWN_TICK_MS = 200
    let intervalId: ReturnType<typeof setInterval> | undefined
    let elapsedBeforePause = 0
    let segmentStartTime = 0
    const [copied, setCopied] = createSignal(false)
    const copyText = () => {
      const parts = [options.title, options.description].filter(Boolean)
      if (parts.length === 0) return
      navigator.clipboard.writeText(parts.join("\n"))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    let isPaused = false

    const updateCountdown = () => {
      const totalElapsed = elapsedBeforePause + (Date.now() - segmentStartTime)
      const remaining = Math.max(0, duration - totalElapsed)
      setCountdown(`${Math.ceil(remaining / 1000)}s`)
      if (remaining <= 0 && intervalId !== undefined) {
        clearInterval(intervalId)
        intervalId = undefined
      }
    }

    if (hasCountdown) {
      segmentStartTime = Date.now()
      intervalId = setInterval(updateCountdown, COUNTDOWN_TICK_MS)
    }

    const pause = () => {
      if (isPaused) return
      if (intervalId !== undefined) {
        clearInterval(intervalId)
        intervalId = undefined
      }
      elapsedBeforePause += Date.now() - segmentStartTime
      isPaused = true
    }

    const resume = () => {
      if (!isPaused) return
      segmentStartTime = Date.now()
      isPaused = false
      intervalId = setInterval(updateCountdown, COUNTDOWN_TICK_MS)
    }

    onCleanup(() => {
      if (intervalId !== undefined) clearInterval(intervalId)
    })

    return (
      <Toast
        toastId={props.toastId}
        duration={duration}
        persistent={options.persistent}
        data-type={type}
        onPointerEnter={pause}
        onPointerLeave={resume}
        onFocusIn={pause}
        onFocusOut={resume}
      >
        <Show when={iconName}>
          <Toast.Icon name={iconName!} />
        </Show>
        <Toast.Content>
          <div class="toast-header">
            <Show when={options.title}>
              <Toast.Title>{options.title}</Toast.Title>
            </Show>
            <Show when={hasCountdown}>
              <span class="toast-countdown">{countdown()}</span>
            </Show>
          </div>
          <div class="toast-body">
            <Show when={options.description}>
              <Toast.Description>{options.description}</Toast.Description>
            </Show>
            <Show when={options.actions?.length}>
              <Toast.Actions>
                {options.actions!.map((action) => (
                  <button
                    data-slot="toast-action"
                    onClick={() => {
                      if (typeof action.onClick === "function") {
                        action.onClick()
                      }
                      toaster.dismiss(props.toastId)
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </Toast.Actions>
            </Show>
          </div>
          <Toast.ProgressTrack>
            <Toast.ProgressFill />
          </Toast.ProgressTrack>
        </Toast.Content>
        <Toast.CopyButton copied={copied()} onClick={copyText} />
        <Toast.CloseButton />
      </Toast>
    )
  })
}

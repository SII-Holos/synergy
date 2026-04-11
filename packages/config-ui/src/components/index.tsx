import { Show, type Component, type JSX } from "solid-js"
import { localeStore, setLocale, useDictionary } from "../locale"
import logoUrl from "../assets/logo.svg"

export const AppChrome: Component<{ class?: string }> = (props) => {
  const { t } = useDictionary()
  const nextLocale = () => (localeStore.locale === "en" ? "zh" : "en")
  const localeButtonLabel = () => (localeStore.locale === "en" ? "EN → 中文" : "中文 → EN")

  return (
    <header class={`su-header ${props.class || ""}`}>
      <div class="su-header-brand">
        <div class="su-mark-wrap">
          <img src={logoUrl} alt="Holos logo" class="su-mark-image" />
        </div>
        <div>
          <div class="text-15-medium" style={{ color: "var(--su-text-strong)" }}>
            {t("appTitle")}
          </div>
          <div class="text-12-regular" style={{ color: "var(--su-text-faint)" }}>
            {t("headerHint")}
          </div>
        </div>
      </div>

      <button type="button" class="su-locale-toggle" onClick={() => setLocale(nextLocale())}>
        <span class="su-locale-toggle-label">{t("localeLabel")}</span>
        <span class="su-locale-toggle-value">{localeButtonLabel()}</span>
      </button>
    </header>
  )
}

export const PageIntro: Component<{
  eyebrow?: string
  title: string
  copy?: string
  hero?: boolean
  class?: string
  children?: JSX.Element
}> = (props) => (
  <div class={`su-page-intro ${props.class || ""}`} classList={{ "su-page-intro-hero": props.hero }}>
    <Show when={props.eyebrow}>
      <div class="su-eyebrow" style={{ "margin-bottom": "0.6rem" }}>
        {props.eyebrow}
      </div>
    </Show>
    <h1 class="su-page-title" classList={{ "su-page-title-hero": props.hero }}>
      {props.title}
    </h1>
    <Show when={props.copy}>
      <p class="su-page-copy" style={{ "margin-top": "0.75rem" }}>
        {props.copy}
      </p>
    </Show>
    {props.children}
  </div>
)

export const SectionCard: Component<{
  class?: string
  children: JSX.Element
}> = (props) => <section class={`su-card ${props.class || ""}`}>{props.children}</section>

export const CodePanel: Component<{
  class?: string
  children: JSX.Element
}> = (props) => <div class={`su-code-panel ${props.class || ""}`}>{props.children}</div>

export type StatusTone = "neutral" | "success" | "critical" | "pending" | "info" | "warning"

export const StatusPill: Component<{
  tone: StatusTone
  children: JSX.Element
}> = (props) => (
  <span
    class="su-pill"
    classList={{
      "su-pill-success": props.tone === "success",
      "su-pill-critical": props.tone === "critical",
      "su-pill-info": props.tone === "info",
      "su-pill-warning": props.tone === "warning",
      "su-pill-neutral": props.tone === "neutral",
    }}
  >
    {props.children}
  </span>
)

export const ValidationBlock: Component<{
  tone?: StatusTone
  accent?: boolean
  class?: string
  children: JSX.Element
}> = (props) => (
  <div
    class={`su-validation-block ${props.class || ""}`}
    classList={{
      "su-validation-block-success": props.tone === "success",
      "su-validation-block-critical": props.tone === "critical",
      "su-validation-block-accent": props.accent,
    }}
  >
    {props.children}
  </div>
)

export const ValidationCard: Component<{
  tone?: StatusTone
  class?: string
  children: JSX.Element
}> = (props) => (
  <div
    class={`su-validation-card ${props.class || ""}`}
    classList={{
      "su-validation-card-success": props.tone === "success",
      "su-validation-card-critical": props.tone === "critical",
      "su-validation-card-neutral": props.tone === "neutral",
    }}
  >
    {props.children}
  </div>
)

export const FieldRow: Component<{
  class?: string
  children: JSX.Element
}> = (props) => <div class={`su-field-row ${props.class || ""}`}>{props.children}</div>

export const InlineAlert: Component<{
  variant: "error" | "info" | "warning"
  children: JSX.Element
}> = (props) => (
  <div
    classList={{
      "su-alert-error": props.variant === "error",
      "su-alert-info": props.variant === "info",
      "su-alert-warning": props.variant === "warning",
    }}
  >
    {props.children}
  </div>
)

export const Tag: Component<{
  tone?: "neutral" | "warning" | "info"
  children: JSX.Element
}> = (props) => (
  <span
    class="su-tag"
    classList={{
      "su-tag-neutral": props.tone === "neutral" || !props.tone,
      "su-tag-warning": props.tone === "warning",
      "su-tag-info": props.tone === "info",
    }}
  >
    {props.children}
  </span>
)

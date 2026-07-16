import { describe, expect, test } from "bun:test"
import {
  analyzeLocalizationSource,
  applyLocalizationAllowlist,
  type LocalizationAllowlistEntry,
} from "./localization-check"

describe("localization source contract", () => {
  test("finds user-visible literals, hardcoded locales, macros, and invalid descriptors", () => {
    const source = `
      import { Trans } from "@lingui/solid/macro"
      const metadata = { title: "Settings", description: "Choose a language" }
      const chinese = "定时唤醒"
      const date = new Intl.DateTimeFormat("en-US")
      const time = value.toLocaleTimeString("zh-CN")
      export function Example() {
        return <section aria-label="Preferences">
          Visible text
          <span>{enabled ? "Enabled" : "Disabled"}</span>
          <Trans id="bad id" message="Invalid ID" />
          <Trans id={dynamicId} message="Dynamic ID" />
          <Trans id="missing.message" />
        </section>
      }
    `

    const violations = analyzeLocalizationSource("packages/app/src/example.tsx", source)
    const kinds = violations.map((item) => item.kind)

    expect(kinds).toContain("macro-import")
    expect(kinds).toContain("user-visible-property")
    expect(kinds).toContain("chinese-literal")
    expect(kinds).toContain("hardcoded-locale")
    expect(kinds).toContain("jsx-text")
    expect(kinds).toContain("jsx-attribute")
    expect(kinds).toContain("invalid-message-id")
    expect(kinds).toContain("dynamic-message-id")
    expect(kinds).toContain("missing-default-message")
  })

  test("accepts runtime descriptors and excludes clearly non-translatable code content", () => {
    const source = `
      import { Trans } from "@lingui/solid"
      const descriptor = /** i18n */ {
        id: "settings.general.language.label",
        message: "Language",
        comment: "General settings row",
      }
      export function Example(props) {
        const { _ } = useLingui()
        const label = _({ id: "session.wake.status.active", message: "Scheduled wake" })
        return <>
          <Trans id="settings.general.language.system" message="Follow system" />
          <code>npm run build</code>
          <pre>{props.rawOutput}</pre>
          <span>{props.pluginLabel}</span>
          <span>{label}</span>
        </>
      }
    `

    expect(analyzeLocalizationSource("packages/app/src/example.tsx", source)).toEqual([])
  })

  test("ignores numeric placeholders, formatter options, and dynamic external content", () => {
    const source = `
      const formatOptions = { title: value, description: plugin.description }
      const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
      export function Example(props) {
        return <>
          <input placeholder="300" />
          <span aria-label={props.pluginLabel} />
          <span title={enabled ? "Enabled" : "Disabled"} />
        </>
      }
    `

    const violations = analyzeLocalizationSource("packages/app/src/example.tsx", source)
    expect(violations.map((item) => [item.kind, item.literal])).toEqual([
      ["jsx-attribute", "Enabled"],
      ["jsx-attribute", "Disabled"],
    ])
  })

  test("accepts statically declared, imported, and factory-produced descriptors", () => {
    const source = `
      import { SESSION_COPY as S, sharedLabel } from "./session-i18n"
      import type { MessageDescriptor } from "@lingui/core"
      const localLabel = { id: "session.local.label", message: "Local label" }
      const labels = {
        ready: { id: "session.state.ready", message: "Ready" },
      }
      function countLabel(count: number) {
        return { id: "session.count.label", message: "{count} items", values: { count } }
      }
      function translateDescriptor(descriptor: MessageDescriptor) {
        return i18n._(descriptor)
      }
      const local = _(localLabel)
      const nested = _(labels.ready)
      const imported = _(S.rewindTitle)
      const importedDirect = _(sharedLabel)
      const factory = _(countLabel(2))
      const withValues = _({ ...localLabel, values: { count: 2 } })
      const accessor = i18n()._(S.rewindTitle)
    `

    expect(analyzeLocalizationSource("packages/app/src/example.ts", source)).toEqual([])
  })

  test("requires runtime translation calls to use static descriptors", () => {
    const source = `
      const translated = _("settings.general.language.label")
      const dynamic = i18n._(descriptor)
      const valid = i18n._({ id: "settings.general.language.label", message: "Language" })
    `

    const violations = analyzeLocalizationSource("packages/app/src/example.ts", source)
    expect(violations.map((item) => item.kind)).toEqual(["invalid-message-descriptor", "invalid-message-descriptor"])
  })

  test("allowlist entries are exact, categorized, and occurrence-scoped", () => {
    const source = `export const Example = () => <><span>Synergy</span><span>Synergy</span></>`
    const violations = analyzeLocalizationSource("packages/app/src/example.tsx", source)
    expect(violations).toHaveLength(2)

    const allowlist: LocalizationAllowlistEntry[] = [
      {
        path: "packages/app/src/example.tsx",
        kind: "jsx-text",
        literal: "Synergy",
        occurrence: 1,
        category: "brand",
        reason: "Product names are not translated.",
      },
    ]

    const remaining = applyLocalizationAllowlist(violations, allowlist)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.occurrence).toBe(2)
  })
})

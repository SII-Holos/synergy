import { describe, expect, test } from "bun:test"
import {
  analyzeLocalizationSource,
  applyLocalizationAllowlist,
  findUnusedLocalizationAllowlistEntries,
  isLocalizationAllowlistCategory,
  type LocalizationAllowlistEntry,
} from "../../script/localization-check"

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
      import { SESSION_COPY as S, sharedLabel } from "../../script/session-i18n"
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

  test("accepts static Trans references, conditional descriptors, and descriptor collection callbacks", () => {
    const source = `
      import { Trans } from "@lingui/solid"
      import { browser as B } from "../../script/messages"
      const local = { id: "app.local.action.label", message: "Local action" }
      const options = [
        { id: "app.option.first.label", message: "First" },
        { id: "app.option.second.label", message: "Second" },
      ]
      export function Example(props) {
        const { _ } = useLingui()
        const labels = options.map((descriptor) => _(descriptor))
        const state = _(props.ready
          ? { id: "app.state.ready.label", message: "Ready" }
          : { id: "app.state.waiting.label", message: "Waiting" })
        return <>
          <Trans id={B.retry.id} message={B.retry.message} />
          <Trans id={local.id} message={local.message} />
          <span>{labels.join(", ")}</span>
          <span>{state}</span>
        </>
      }
    `

    expect(analyzeLocalizationSource("packages/app/src/example.tsx", source)).toEqual([])
  })

  test("accepts structurally typed descriptor helpers and descriptor property pairs", () => {
    const source = `
      import { agenda as A } from "../../script/messages"
      const local = { id: "app.local.ready.label", message: "Ready" }
      const translate = (descriptor: { id: string; message: string }, values?: Record<string, unknown>) =>
        i18n._(values ? { ...descriptor, values } : descriptor)
      const imported = i18n._({ ...A.total, values: { total: 2 } })
      const importedWithMessage = i18n._({ ...A.total, message: A.total.message, values: { total: 2 } })
      const localPair = i18n._({ id: local.id, message: local.message, values: { count: 2 } })
      const translated = translate(A.total, { total: 2 })
    `

    expect(analyzeLocalizationSource("packages/app/src/example.ts", source)).toEqual([])
  })

  test("accepts typed descriptor props and statically complete descriptor maps", () => {
    const source = `
      import type { MessageDescriptor } from "@lingui/core"
      interface ConfirmOptions {
        title: MessageDescriptor
        cancelLabel?: MessageDescriptor
        externalText: string
      }
      type RowDefinition = {
        label: MessageDescriptor
        detail?: MessageDescriptor
      }
      const unitDescriptors = {
        minutes: { id: "app.duration.minutes.label", message: "minutes" },
        hours: { id: "app.duration.hours.label", message: "hours" },
      }
      function ConfirmDialog(props: ConfirmOptions) {
        const title = _(props.title)
        const cancel = props.cancelLabel ? _(props.cancelLabel) : ""
        return title + cancel
      }
      function row(def: RowDefinition) {
        return _(def.label)
      }
      function unitLabel(unit: keyof typeof unitDescriptors) {
        return _(unitDescriptors[unit])
      }
    `

    expect(analyzeLocalizationSource("packages/app/src/example.ts", source)).toEqual([])
  })

  test("rejects properties whose type also permits arbitrary strings", () => {
    const mixedType = analyzeLocalizationSource(
      "packages/app/src/mixed.ts",
      `
        import type { MessageDescriptor } from "@lingui/core"
        interface MixedOptions { title: string | MessageDescriptor }
        function render(props: MixedOptions) { return _(props.title) }
      `,
    )
    expect(mixedType.map((item) => item.kind)).toEqual(["invalid-message-descriptor"])
  })

  test("requires runtime translation calls to use static descriptors", () => {
    const source = `
      const translated = _("settings.general.language.label")
      const dynamic = i18n._(descriptor)
      const valid = i18n._({ id: "settings.general.language.label", message: "Language" })
    `

    const violations = analyzeLocalizationSource("packages/app/src/example.ts", source)
    expect(violations.map((item) => item.kind)).toEqual(["invalid-message-descriptor", "invalid-message-descriptor"])

    const dynamicOverride = analyzeLocalizationSource(
      "packages/app/src/dynamic.ts",
      `import { agenda as A } from "../../script/messages"; i18n._({ ...A.total, id: dynamicID })`,
    )
    expect(dynamicOverride.map((item) => item.kind)).toEqual(["dynamic-message-id"])
  })

  test("rejects descriptor maps indexed by unconstrained dynamic strings", () => {
    const unsafeMapLookup = analyzeLocalizationSource(
      "packages/app/src/dynamic-map.ts",
      `
        const labels = { ready: { id: "app.state.ready.label", message: "Ready" } }
        function label(key: string) { return _(labels[key]) }
      `,
    )
    expect(unsafeMapLookup.map((item) => item.kind)).toEqual(["invalid-message-descriptor"])
  })

  test("rejects unknown allowlist categories", () => {
    expect(isLocalizationAllowlistCategory("brand")).toBe(true)
    expect(isLocalizationAllowlistCategory("language-self-name")).toBe(true)
    expect(isLocalizationAllowlistCategory("misc")).toBe(false)
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

  test("reports stale allowlist entries after their source violation is removed", () => {
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

    expect(findUnusedLocalizationAllowlistEntries([], allowlist)).toEqual(allowlist)
    const violations = analyzeLocalizationSource(
      "packages/app/src/example.tsx",
      `export const Example = () => <span>Synergy</span>`,
    )
    expect(findUnusedLocalizationAllowlistEntries(violations, allowlist)).toEqual([])
  })
})

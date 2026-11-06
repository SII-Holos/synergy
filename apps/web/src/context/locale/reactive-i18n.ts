import type { I18n } from "@lingui/core"
import type { Accessor } from "solid-js"

export function createReactiveI18n(i18n: I18n, generation: Accessor<number>): I18n {
  const delegate = i18n._.bind(i18n) as I18n["_"]
  const translate = ((...args: Parameters<I18n["_"]>) => {
    generation()
    return delegate(...args)
  }) as I18n["_"]

  return new Proxy(i18n, {
    get(target, property) {
      if (property === "_") return translate
      return Reflect.get(target, property, target)
    },
  })
}

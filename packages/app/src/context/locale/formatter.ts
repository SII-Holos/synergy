import type { ActiveLocale } from "./types"

function optionsKey(options: object | undefined): string {
  if (!options) return ""
  return Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join("|")
}

const dateTimeComponentKeys = [
  "weekday",
  "era",
  "year",
  "month",
  "day",
  "dayPeriod",
  "hour",
  "minute",
  "second",
  "fractionalSecondDigits",
  "timeZoneName",
] as const

function hasDateTimeComponents(options: Intl.DateTimeFormatOptions | undefined): boolean {
  return dateTimeComponentKeys.some((key) => options?.[key] !== undefined)
}

export interface IntlFormatter {
  number(value: number, options?: Intl.NumberFormatOptions): string
  percent(value: number, options?: Intl.NumberFormatOptions): string
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string
  list(values: Iterable<string>, options?: Intl.ListFormatOptions): string
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  dateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  time(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  relative(value: Date | number, base?: Date): string
}

export function createIntlFormatter(getLocale: () => ActiveLocale): IntlFormatter {
  let lastLocale: ActiveLocale | undefined
  const numberFormats = new Map<string, Intl.NumberFormat>()
  const dateTimeFormats = new Map<string, Intl.DateTimeFormat>()
  const listFormats = new Map<string, Intl.ListFormat>()
  let rtf: Intl.RelativeTimeFormat | undefined

  function ensureLocale(): ActiveLocale {
    const locale = getLocale()
    if (locale !== lastLocale) {
      lastLocale = locale
      numberFormats.clear()
      dateTimeFormats.clear()
      listFormats.clear()
      rtf = undefined
    }
    return locale
  }

  function getNF(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
    const key = optionsKey(options)
    const cached = numberFormats.get(key)
    if (cached) return cached

    const formatter = new Intl.NumberFormat(lastLocale!, options)
    numberFormats.set(key, formatter)
    return formatter
  }

  function getDTF(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = optionsKey(options)
    const cached = dateTimeFormats.get(key)
    if (cached) return cached

    const formatter = new Intl.DateTimeFormat(lastLocale!, options)
    dateTimeFormats.set(key, formatter)
    return formatter
  }

  function getLF(options?: Intl.ListFormatOptions): Intl.ListFormat {
    const key = optionsKey(options)
    const cached = listFormats.get(key)
    if (cached) return cached

    const formatter = new Intl.ListFormat(lastLocale!, options)
    listFormats.set(key, formatter)
    return formatter
  }

  function ensureRTF(): Intl.RelativeTimeFormat {
    if (!rtf) {
      const locale = lastLocale!
      rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
    }
    return rtf
  }

  const res: IntlFormatter = {
    number(value, options?) {
      ensureLocale()
      return getNF(options).format(value)
    },

    percent(value, options?) {
      ensureLocale()
      return getNF({ style: "percent", ...options }).format(value)
    },

    currency(value, currency, options?) {
      ensureLocale()
      return getNF({ style: "currency", currency, ...options }).format(value)
    },

    list(values, options?) {
      ensureLocale()
      return getLF(options).format(values)
    },

    date(value, options?) {
      ensureLocale()
      return getDTF(options).format(value)
    },

    dateTime(value, options?) {
      ensureLocale()
      const resolved: Intl.DateTimeFormatOptions | undefined = hasDateTimeComponents(options)
        ? options
        : { dateStyle: "medium", timeStyle: "short", ...options }
      return getDTF(resolved).format(value)
    },

    time(value, options?) {
      ensureLocale()
      const resolved: Intl.DateTimeFormatOptions | undefined = hasDateTimeComponents(options)
        ? options
        : { timeStyle: "short", ...options }
      return getDTF(resolved).format(value)
    },

    relative(value, base?) {
      ensureLocale()
      const now = base ?? new Date()
      const then = value instanceof Date ? value : new Date(value)
      const diffMs = then.getTime() - now.getTime()
      const absMs = Math.abs(diffMs)

      const formatter = ensureRTF()

      const units: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
        { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
        { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
        { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
        { unit: "day", ms: 24 * 60 * 60 * 1000 },
        { unit: "hour", ms: 60 * 60 * 1000 },
        { unit: "minute", ms: 60 * 1000 },
        { unit: "second", ms: 1000 },
      ]

      for (const { unit, ms } of units) {
        if (absMs >= ms || unit === "second") {
          const value = Math.round(diffMs / ms)
          return formatter.format(value, unit)
        }
      }

      return formatter.format(0, "second")
    },
  }

  return res
}

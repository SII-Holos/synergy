import type { ActiveLocale } from "./types"

export interface IntlFormatter {
  number(value: number, options?: Intl.NumberFormatOptions): string
  percent(value: number, options?: Intl.NumberFormatOptions): string
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  dateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  time(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  relative(value: Date | number, base?: Date): string
}

export function createIntlFormatter(getLocale: () => ActiveLocale): IntlFormatter {
  let lastLocale: ActiveLocale | undefined
  let nf: Intl.NumberFormat | undefined
  let dtf: Intl.DateTimeFormat | undefined
  let rtf: Intl.RelativeTimeFormat | undefined

  function ensureLocale(): ActiveLocale {
    const locale = getLocale()
    if (locale !== lastLocale) {
      lastLocale = locale
      nf = undefined
      dtf = undefined
      rtf = undefined
    }
    return locale
  }

  function getNF(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
    if (!nf) {
      const locale = lastLocale!
      nf = new Intl.NumberFormat(locale)
    }
    if (options) {
      return new Intl.NumberFormat(lastLocale!, options)
    }
    return nf
  }

  function getDTF(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    if (!dtf) {
      const locale = lastLocale!
      dtf = new Intl.DateTimeFormat(locale)
    }
    if (options) {
      return new Intl.DateTimeFormat(lastLocale!, options)
    }
    return dtf
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

    date(value, options?) {
      ensureLocale()
      return getDTF(options).format(value)
    },

    dateTime(value, options?) {
      ensureLocale()
      return getDTF({ dateStyle: "medium", timeStyle: "short", ...options }).format(value)
    },

    time(value, options?) {
      ensureLocale()
      return getDTF({ timeStyle: "short", ...options }).format(value)
    },

    relative(value, base?) {
      const locale = ensureLocale()
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

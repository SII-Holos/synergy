export function createPluginFormatter(locale: () => string) {
  return {
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale(), options).format(value),
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale(), options).format(value),
    relative: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) =>
      new Intl.RelativeTimeFormat(locale(), { numeric: "auto", ...options }).format(value, unit),
    bytes(value: number) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError("Byte count must be finite and nonnegative")
      const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const
      const index = Math.min(value ? Math.floor(Math.log(value) / Math.log(1000)) : 0, units.length - 1)
      return new Intl.NumberFormat(locale(), {
        style: "unit",
        unit: units[Math.max(0, index)]!,
        maximumFractionDigits: 1,
      }).format(value / 1000 ** Math.max(0, index))
    },
  }
}

/**
 * ratingStars — converts a numeric rating (0–max) to an array of star states.
 *
 * Each entry is "filled", "half", or "empty". Supports half-star increments:
 * fractional part ≥ 0.5 gets a half-star; < 0.5 rounds down.
 * Values outside [0, max] are clamped.
 *
 * Example: ratingStars(3.8) → ["filled","filled","filled","half","empty"]
 */
export function ratingStars(rating: number, max: number = 5): ("filled" | "half" | "empty")[] {
  const clamped = Math.max(0, Math.min(rating, max))
  const filled = Math.floor(clamped)
  const remaining = max - filled
  const hasHalf = clamped - filled >= 0.5
  const empty = hasHalf ? remaining - 1 : remaining

  return [
    ...Array<"filled">(filled).fill("filled"),
    ...(hasHalf ? Array<"half">(1).fill("half") : []),
    ...Array<"empty">(empty).fill("empty"),
  ]
}

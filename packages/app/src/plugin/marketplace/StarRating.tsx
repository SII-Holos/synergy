import { Show, For } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ratingStars } from "./rating-stars"

/**
 * Renders a star rating display with filled/half/empty stars.
 * Optionally shows the numeric rating and count when available.
 */
export function StarRating(props: {
  rating?: number
  count?: number
  /** When true, shows larger stars with adjacent numeric text. Default: false */
  compact?: boolean
}) {
  const stars = () => ratingStars(props.rating ?? 0)
  const starIcon = (state: string) => {
    if (state === "filled") return "star"
    if (state === "half") return "star-half"
    return "star-off"
  }

  return (
    <span class="inline-flex items-center gap-0.5">
      <For each={stars()}>
        {(state) => (
          <Icon
            name={starIcon(state)}
            size="small"
            class={
              state === "filled"
                ? "text-text-warning"
                : state === "half"
                  ? "text-text-warning/60"
                  : "text-text-weaker/40"
            }
          />
        )}
      </For>
      <Show when={props.rating != null}>
        <span class="text-13-medium text-text-base ml-1">{props.rating?.toFixed(1)}</span>
      </Show>
      <Show when={props.count != null && props.count > 0}>
        <span class="text-11-regular text-text-weaker ml-1">({props.count})</span>
      </Show>
    </span>
  )
}

export type ActivityCountTransition = {
  identity: string
  current: number
  previous?: number
  animating: boolean
  revision: number
}

export function reduceActivityCountTransition(
  state: ActivityCountTransition | undefined,
  input: { identity: string; value: number; reducedMotion: boolean },
): ActivityCountTransition {
  if (!state) return { identity: input.identity, current: input.value, animating: false, revision: 0 }
  if (state.identity === input.identity && state.current === input.value) return state

  const revision = state.revision + 1
  if (input.reducedMotion || state.identity !== input.identity || input.value < state.current) {
    return { identity: input.identity, current: input.value, animating: false, revision }
  }

  return {
    identity: input.identity,
    current: input.value,
    previous: state.current,
    animating: true,
    revision,
  }
}

export function finishActivityCountTransition(
  state: ActivityCountTransition,
  revision: number,
): ActivityCountTransition {
  if (!state.animating || state.revision !== revision) return state
  return { identity: state.identity, current: state.current, animating: false, revision: state.revision }
}

export interface TextPartProjectionInput {
  key: string
  source: string
  completed: boolean
}

export function isTextPartTerminal(input: { partEnd?: number; messageCompleted?: number }) {
  return input.partEnd !== undefined || input.messageCompleted !== undefined
}

interface IncrementalTransform {
  write(chunk: string): string
}

function createTrimTransform(): IncrementalTransform {
  let started = false
  let whitespace = ""

  return {
    write(chunk) {
      let output = ""
      for (const character of chunk) {
        if (character.trim().length === 0) {
          if (started) whitespace += character
          continue
        }

        if (!started) started = true
        output += whitespace + character
        whitespace = ""
      }
      return output
    },
  }
}

export function createTextPartProjection() {
  let key: string | undefined
  let sourceLength = 0
  let completed = false
  let output = ""
  let trim = createTrimTransform()

  const reset = (input: TextPartProjectionInput) => {
    key = input.key
    sourceLength = input.source.length
    completed = input.completed
    trim = createTrimTransform()
    output = input.completed ? input.source.trim() : trim.write(input.source)
    return output
  }

  return {
    project(input: TextPartProjectionInput) {
      if (key !== input.key || input.source.length < sourceLength || input.completed !== completed) {
        return reset(input)
      }

      if (input.completed) {
        if (input.source.length !== sourceLength) return reset(input)
        return output
      }

      const delta = input.source.slice(sourceLength)
      sourceLength = input.source.length
      if (delta) output += trim.write(delta)
      return output
    },
  }
}

import readline from "node:readline"

export const isInteractive = () =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY)

const setRaw = (on: boolean) => {
  const s: any = process.stdin
  if (s.isTTY && typeof s.setRawMode === "function") s.setRawMode(on)
}

export const promptText = (query: string, def = ""): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const suffix = def ? ` [${def}]` : ""
    rl.question(`${query}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || def)
    })
  })

export const promptConfirm = (query: string, def = false): Promise<boolean> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(`${query} [${def ? "Y/n" : "y/N"}]: `, (answer) => {
      rl.close()
      const a = answer.trim().toLowerCase()
      resolve(a ? a === "y" || a === "yes" : def)
    })
  })

export const promptHidden = (query: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const output = (rl as any).output
    let started = false
    ;(rl as any)._writeToOutput = (chunk: string) => {
      if (!started) {
        output.write(chunk)
        if (chunk.includes(query)) started = true
        return
      }
      // mask everything typed after the prompt is shown
    }
    rl.question(query, (answer) => {
      output.write("\n")
      rl.close()
      resolve(answer.trim())
    })
  })

type Choice<T> = { label: string; value: T }

const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

// Arrow-key single select. Falls back to the first/initial choice when stdin
// isn't an interactive TTY (callers gate on isInteractive() before prompting).
export const selectOne = <T>(
  message: string,
  choices: Choice<T>[],
  initial = 0,
): Promise<T> =>
  new Promise((resolve) => {
    if (!isInteractive() || choices.length === 0) {
      resolve(choices[Math.min(initial, choices.length - 1)]?.value)
      return
    }
    let idx = Math.max(0, Math.min(initial, choices.length - 1))
    const out = process.stdout
    out.write(message + "\n")
    const render = (first: boolean) => {
      if (!first) out.write(`\x1b[${choices.length}A`)
      for (let i = 0; i < choices.length; i++) {
        const on = i === idx
        const row = `${on ? "❯" : " "} ${choices[i].label}`
        out.write(`\x1b[2K  ${on ? CYAN + row + RESET : row}\n`)
      }
    }
    render(true)
    readline.emitKeypressEvents(process.stdin)
    setRaw(true)
    process.stdin.resume()
    const cleanup = () => {
      process.stdin.off("keypress", onKey)
      setRaw(false)
      process.stdin.pause()
    }
    const onKey = (_s: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        idx = (idx - 1 + choices.length) % choices.length
        render(false)
      } else if (key.name === "down" || key.name === "j") {
        idx = (idx + 1) % choices.length
        render(false)
      } else if (key.name === "return" || key.name === "enter") {
        cleanup()
        resolve(choices[idx].value)
      } else if (key.ctrl && key.name === "c") {
        cleanup()
        out.write("\n")
        process.exit(130)
      }
    }
    process.stdin.on("keypress", onKey)
  })

// Arrow-key multi select: ↑/↓ to move, space to toggle, enter to confirm.
export const selectMany = (
  message: string,
  choices: { label: string; value: string; checked?: boolean }[],
): Promise<string[]> =>
  new Promise((resolve) => {
    const checked = choices.map((c) => !!c.checked)
    const collect = () =>
      choices.filter((_, i) => checked[i]).map((c) => c.value)
    if (!isInteractive() || choices.length === 0) {
      resolve(collect())
      return
    }
    let idx = 0
    const out = process.stdout
    out.write(message + "\n")
    const render = (first: boolean) => {
      if (!first) out.write(`\x1b[${choices.length}A`)
      for (let i = 0; i < choices.length; i++) {
        const on = i === idx
        const row = `${on ? "❯" : " "} ${checked[i] ? "◉" : "◯"} ${choices[i].label}`
        out.write(`\x1b[2K  ${on ? CYAN + row + RESET : row}\n`)
      }
    }
    render(true)
    readline.emitKeypressEvents(process.stdin)
    setRaw(true)
    process.stdin.resume()
    const cleanup = () => {
      process.stdin.off("keypress", onKey)
      setRaw(false)
      process.stdin.pause()
    }
    const onKey = (s: string, key: readline.Key) => {
      if (key.name === "up" || key.name === "k") {
        idx = (idx - 1 + choices.length) % choices.length
        render(false)
      } else if (key.name === "down" || key.name === "j") {
        idx = (idx + 1) % choices.length
        render(false)
      } else if (key.name === "space" || s === " ") {
        checked[idx] = !checked[idx]
        render(false)
      } else if (key.name === "return" || key.name === "enter") {
        cleanup()
        resolve(collect())
      } else if (key.ctrl && key.name === "c") {
        cleanup()
        out.write("\n")
        process.exit(130)
      }
    }
    process.stdin.on("keypress", onKey)
  })

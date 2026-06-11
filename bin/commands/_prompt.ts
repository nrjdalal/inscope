import readline from "node:readline"

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

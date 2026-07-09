import { handleMcpRequest, type JsonRpcRequest } from "@/mcp"

// Run inscope as a Model Context Protocol server over stdio, so a Claude Code
// client can call inscope's tools. Reads newline-delimited JSON-RPC from stdin,
// writes each response to stdout, and stays up until stdin closes. stdout is
// reserved for protocol messages only, so nothing here logs to it.
export const mcp = () => {
  let buffer = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let req: JsonRpcRequest
      try {
        req = JSON.parse(line) as JsonRpcRequest
      } catch {
        continue // a line that isn't valid JSON is not a protocol message; skip it
      }
      const res = handleMcpRequest(req)
      if (res) process.stdout.write(JSON.stringify(res) + "\n")
    }
  })
  process.stdin.on("end", () => process.exit(0))
  process.stdin.resume()
}

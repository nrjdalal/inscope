// The dashboard's pages, each with text it shows only once its data has loaded on the sandbox: the sidebar repeats every page's title, so waiting for a title proves nothing. The browser suite visits these, at desktop and phone widths.
export const PAGES = [
  { loaded: "MCP not written", path: "/inscope" },
  { loaded: "old-notes", path: "/inscope/skills" },
  { loaded: "[acme] gh", path: "/inscope/doctor" },
  { loaded: "Hand edits apply would undo", path: "/inscope/diff" },
  { loaded: "Claude login", path: "/inscope/workspaces/acme" },
  { loaded: "Claude login", path: "/inscope/workspaces/work" },
] as const

// Every route the dashboard's API serves on the sandbox, under /api/inscope, each workspace's detail included: what a credential sweep reads.
export const ROUTES = [
  "",
  "/diff",
  "/doctor",
  "/status",
  "/workspaces/acme",
  "/workspaces/personal",
  "/workspaces/work",
] as const

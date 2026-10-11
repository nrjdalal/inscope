import { notFound } from "next/navigation"

// Catch-all so an unknown dashboard path renders inside the dashboard layout and lands in its not-found boundary.
export default function Page() {
  notFound()
}

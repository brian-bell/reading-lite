import { createFileRoute } from "@tanstack/react-router";
import { SampleLibraryPage } from "../components/SamplePages";

// The public sample library (reading-lite-gh341.10). No identity in the server
// render; request-policy leaves it off private, no-store (public-paths.ts).
export const Route = createFileRoute("/samples")({
  head: () => ({ meta: [{ title: "Sample library · Reading Lite" }] }),
  component: SampleLibraryPage,
});

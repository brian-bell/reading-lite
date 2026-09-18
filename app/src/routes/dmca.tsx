import { createFileRoute } from "@tanstack/react-router";
import { DmcaPage } from "../components/LegalPages";
import { DMCA_DOCUMENT } from "../legal-copy";

// Public legal notice (acceptance matrix, ADR 0003). No identity in the
// server render; request-policy leaves these pages off private, no-store.
export const Route = createFileRoute("/dmca")({
  head: () => ({ meta: [{ title: `${DMCA_DOCUMENT.title} · Reading Lite` }] }),
  component: DmcaPage,
});

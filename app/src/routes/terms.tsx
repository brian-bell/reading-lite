import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "../components/LegalPages";
import { TERMS_DOCUMENT } from "../legal-copy";

// Public legal notice (acceptance matrix, ADR 0003). No identity in the
// server render; request-policy leaves these pages off private, no-store.
export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: `${TERMS_DOCUMENT.title} · Reading Lite` }] }),
  component: TermsPage,
});

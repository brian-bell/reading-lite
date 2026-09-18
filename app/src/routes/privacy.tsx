import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "../components/LegalPages";
import { PRIVACY_DOCUMENT } from "../legal-copy";

// Public legal notice (acceptance matrix, ADR 0003). No identity in the
// server render; request-policy leaves these pages off private, no-store.
export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: `${PRIVACY_DOCUMENT.title} · Reading Lite` }] }),
  component: PrivacyPage,
});

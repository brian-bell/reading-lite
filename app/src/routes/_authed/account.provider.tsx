import { createFileRoute } from "@tanstack/react-router";
import { ProviderPage } from "../../components/ProviderPage";

// Provider settings (reading-lite-gh341.8; ADR 0004): the reader's OpenAI key,
// summary effort, and daily spending limit. Under the signed-in guard: a link
// from the account menu or a step-up return signs the reader in and lands here.
export const Route = createFileRoute("/_authed/account/provider")({
  head: () => ({ meta: [{ title: "Provider · Reading Lite" }] }),
  component: ProviderPage,
});

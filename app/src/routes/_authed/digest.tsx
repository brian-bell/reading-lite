import { createFileRoute } from "@tanstack/react-router";
import { DigestPage } from "../../components/DigestPage";

// The digest preview (reading-lite-kl7y.10): the next digest mail as it stands
// now. A browser read, so there is no loader; the server render is the page's
// frame with its content busy.
export const Route = createFileRoute("/_authed/digest")({
  head: () => ({ meta: [{ title: "Digest preview · Reading Lite" }] }),
  component: DigestPage,
});

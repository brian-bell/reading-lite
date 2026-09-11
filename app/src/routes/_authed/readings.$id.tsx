import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "../../components/PageHeading";

// Placeholder until server-rendered reading detail lands (#370). The route
// exists now so signed-out direct links return here after sign-in.
export const Route = createFileRoute("/_authed/readings/$id")({
  head: () => ({ meta: [{ title: "Reading · Reading Lite" }] }),
  component: ReadingPage,
});

function ReadingPage() {
  return (
    <div className="page">
      <PageHeading>Reading</PageHeading>
    </div>
  );
}

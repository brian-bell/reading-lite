import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "../components/PageHeading";

// Placeholder until URL and Markdown capture land (Phase 4, #339).
export const Route = createFileRoute("/save")({
  head: () => ({ meta: [{ title: "Save reading · Reading Lite" }] }),
  component: SavePage,
});

function SavePage() {
  return (
    <div className="page">
      <PageHeading>Save reading</PageHeading>
    </div>
  );
}

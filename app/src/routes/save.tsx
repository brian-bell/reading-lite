import { createFileRoute } from "@tanstack/react-router";

// Placeholder until URL and Markdown capture land (Phase 4, #339).
export const Route = createFileRoute("/save")({
  head: () => ({ meta: [{ title: "Save reading · Reading Lite" }] }),
  component: SavePage,
});

function SavePage() {
  return (
    <div className="page">
      <h1 className="page-title">Save reading</h1>
    </div>
  );
}

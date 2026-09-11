import { createFileRoute } from "@tanstack/react-router";

// Placeholder until the library lands (Phase 4, #339).
export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Library · Reading Lite" }] }),
  component: LibraryPage,
});

function LibraryPage() {
  return (
    <div className="page">
      <h1 className="page-title">Library</h1>
    </div>
  );
}

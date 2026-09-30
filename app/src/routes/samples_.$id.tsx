import { createFileRoute } from "@tanstack/react-router";
import { SampleReadingPage } from "../components/SamplePages";
import { sampleReading } from "../samples";

// One sample reading (reading-lite-gh341.10), bundled with the frontend, so
// nothing is loaded: public, and not nested under /samples' page, which is the
// list.
export const Route = createFileRoute("/samples_/$id")({
  head: ({ params }) => ({
    meta: [{ title: `${sampleReading(params.id)?.title ?? "Sample"} · Sample · Reading Lite` }],
  }),
  component: SampleRoute,
});

function SampleRoute() {
  const { id } = Route.useParams();
  return <SampleReadingPage id={id} />;
}

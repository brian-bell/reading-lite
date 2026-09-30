import { z } from "zod";
import { ReadingSchema, type Reading } from "./reading";
import library from "./samples/sample-library.json";

// The public sample library (reading-lite-gh341.10): a few authored readings
// from the fixture pack (docs/design/connected/fixture-pack.md), bundled here
// so a reader can see summaries, connections, and tensions before signing in
// or connecting a key. Nothing here is read from the backend.
//
// samples/sample-library.json is generated from the pack by the repo root's
// `npm run fixtures:app`; its drift test is the root's
// test/unit/fixtures/app-fixture-pack.test.ts. Each reading's id is a slug,
// and its connections and tensions name only other samples, so the reading
// page's relationship cards lead from one sample to another.
//
// Parsed through the same projection the reading page reads the backend's
// answer with, so a sample renders exactly as a reading would.

export const SAMPLE_READINGS: readonly Reading[] = z.array(ReadingSchema).parse(library.readings);

export function sampleReading(id: string): Reading | undefined {
  return SAMPLE_READINGS.find((reading) => reading.id === id);
}

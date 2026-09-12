import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import {
  degradationNotice,
  hostnameOf,
  noveltyPanel,
  savedOn,
  sourceLabel,
  summaryBodyBelowLead,
} from "../src/reading-presentation";
import type { Reading } from "../src/reading";

// The Summary view's derived copy (design spec, Data mapping and Novelty).
// Every sentence here is fixed by the specification, so these are the tests
// that fail when the copy drifts from it.

const readings = pack.readings as Record<string, Reading>;

function ready(fields: Partial<Reading>): Reading {
  return { id: "rd_1", url: "https://example.com/a", status: "ready", ...fields };
}

describe("the metadata line", () => {
  it("uses the hostname where the prototype had an author and publication", () => {
    expect(hostnameOf("https://www.fieldnotes.example/2026/a")).toBe("fieldnotes.example");
  });

  it("keeps a URL it cannot parse rather than blanking the line", () => {
    expect(hostnameOf("not a url")).toBe("not a url");
  });

  it("reads created_at as a saved date", () => {
    expect(savedOn("2026-09-07T09:30:00.000Z")).toBe("Saved 7 September 2026");
  });

  it("says nothing when there is no date, or the date is unreadable", () => {
    expect(savedOn(undefined)).toBeUndefined();
    expect(savedOn("the other day")).toBeUndefined();
  });

  it("calls out imported Markdown and nothing else", () => {
    expect(sourceLabel("markdown")).toBe("Imported Markdown");
    expect(sourceLabel("url")).toBeUndefined();
    expect(sourceLabel(undefined)).toBeUndefined();
  });
});

describe("the novelty panel", () => {
  // Design spec, Novelty: the label and one fixed sentence per verdict.
  it.each([
    ["novel", "Novel", "Nothing already in your library covers this closely."],
    ["familiar", "Familiar", "Overlaps with readings already in your library."],
    ["duplicate", "Duplicate", "Effectively the same piece as one already in your library."],
  ])("says what %s means", (verdict, label, sentence) => {
    const panel = noveltyPanel(ready({ novelty_verdict: verdict, similarity: { count: 2 } }));
    expect(panel).toEqual({ label, sentence });
  });

  // A library with nothing close is not the same claim as a novel reading, and
  // the spec replaces the sentence rather than the label.
  it("replaces the sentence when nothing close was in the library", () => {
    const panel = noveltyPanel(ready({ novelty_verdict: "novel", similarity: { count: 0 } }));
    expect(panel).toEqual({
      label: "Novel",
      sentence: "Your library had no close readings when this was processed.",
    });
  });

  it("keeps the verdict's own label with the sparse sentence", () => {
    expect(noveltyPanel(ready({ novelty_verdict: "familiar", similarity: { count: 0 } }))).toMatchObject({
      label: "Familiar",
    });
  });

  // "count is missing" is not "count is zero": an older manifest that never
  // recorded one must not be described as having had an empty library.
  it("keeps the verdict's sentence when no count was recorded", () => {
    expect(noveltyPanel(ready({ novelty_verdict: "novel" }))).toMatchObject({
      sentence: "Nothing already in your library covers this closely.",
    });
  });

  it("omits the panel when the manifest carries no verdict", () => {
    expect(noveltyPanel(ready({ similarity: { count: 3 } }))).toBeUndefined();
  });

  // The three verdicts are the whole enum. A fourth would arrive with its own
  // sentence; until then there is nothing true to say about it.
  it("omits the panel rather than inventing a sentence for an unknown verdict", () => {
    expect(noveltyPanel(ready({ novelty_verdict: "unclassified" }))).toBeUndefined();
  });

  // Novelty is judged when a reading is summarized, so it belongs to a reading
  // that has been.
  it("shows nothing for a reading that is not ready", () => {
    expect(noveltyPanel({ ...ready({ novelty_verdict: "novel" }), status: "pending" })).toBeUndefined();
    expect(noveltyPanel({ ...ready({ novelty_verdict: "novel" }), status: "failed" })).toBeUndefined();
  });

  it("matches the fixture pack's ready readings", () => {
    expect(noveltyPanel(readings.rd_FXATTENT01!)).toMatchObject({ label: "Familiar" });
    expect(noveltyPanel(readings.rd_FXSPARSE01!)).toEqual({
      label: "Novel",
      sentence: "Your library had no close readings when this was processed.",
    });
    // The old manifest predates novelty entirely.
    expect(noveltyPanel(readings.rd_FXPAST0001!)).toBeUndefined();
  });
});

describe("the degraded-YouTube notice", () => {
  // The watch page carries the description and the caption list, so losing it
  // loses both; losing only the transcript keeps the description.
  it("names the transcript when only the transcript was missing", () => {
    expect(degradationNotice({ source: "youtube", tier: "transcript" })).toBe(
      "This video's transcript couldn't be read, so the summary is based on its title, channel, and description.",
    );
  });

  it("names the description and transcript when the watch page was missing", () => {
    expect(degradationNotice({ source: "youtube", tier: "watch_page" })).toBe(
      "This video's description and transcript couldn't be read, so the summary is based on its title and channel alone.",
    );
  });

  it("says nothing when the reading was fully enriched", () => {
    expect(degradationNotice(undefined)).toBeUndefined();
  });

  // A new tier is a backend change that arrives with its own sentence. Naming
  // nothing would be worse than staying quiet.
  it("stays quiet about a tier it has no sentence for", () => {
    expect(degradationNotice({ source: "youtube", tier: "chapters" })).toBeUndefined();
  });

  it("matches the fixture pack's degraded YouTube reading", () => {
    expect(degradationNotice(readings.rd_FXYTDEGRD1!.enrichment_degradation)).toContain("transcript couldn't be read");
  });
});

describe("the summary body below the lead", () => {
  // The summarizer routinely opens summary_markdown with the tldr itself, so
  // rendering both verbatim prints the lead twice. Only an exact match is
  // dropped: a paragraph that merely resembles the lead is the author's.
  it("drops a first paragraph that is exactly the lead", () => {
    expect(summaryBodyBelowLead("The thesis.", "The thesis.\n\nThe argument.")).toBe("The argument.");
  });

  it("ignores whitespace around the repeat", () => {
    expect(summaryBodyBelowLead("The thesis.", "  The thesis.  \n\nThe argument.")).toBe("The argument.");
  });

  it("keeps a first paragraph that only resembles the lead", () => {
    const body = "The thesis, restated at length.\n\nThe argument.";
    expect(summaryBodyBelowLead("The thesis.", body)).toBe(body);
  });

  it("renders nothing below a lead the summary only repeats", () => {
    expect(summaryBodyBelowLead("The thesis.", "The thesis.")).toBeUndefined();
  });

  it("keeps the whole summary when there is no lead", () => {
    expect(summaryBodyBelowLead(undefined, "The thesis.\n\nThe argument.")).toBe("The thesis.\n\nThe argument.");
  });

  it("says nothing when there is no summary", () => {
    expect(summaryBodyBelowLead("The thesis.", undefined)).toBeUndefined();
    expect(summaryBodyBelowLead("The thesis.", "   ")).toBeUndefined();
  });

  it("leaves the fixture pack's summaries without their repeated lead", () => {
    const reading = readings.rd_FXATTENT01!;
    const body = summaryBodyBelowLead(reading.tldr, reading.summary_markdown)!;
    expect(body.startsWith("Saving is only the beginning.")).toBe(true);
    expect(body).not.toContain(reading.tldr!);
  });
});

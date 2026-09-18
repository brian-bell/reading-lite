import { describe, expect, it } from "vitest";
import {
  SOURCE_DATE_MIN,
  sourceDateFromMarkdownFrontMatter,
  sourceDateFromPublishedTime,
} from "../../../src/modules/extractor/source-date";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

describe("sourceDateFromPublishedTime", () => {
  it("normalizes an ISO timestamp to the UTC calendar date", () => {
    expect(sourceDateFromPublishedTime("2024-03-15T18:30:00.000Z", NOW)).toBe("2024-03-15");
    expect(sourceDateFromPublishedTime("2024-03-15", NOW)).toBe("2024-03-15");
  });

  it("uses the UTC calendar date when a local offset crosses midnight", () => {
    // 23:00 on 15 March in UTC−5 is 04:00 on 16 March UTC.
    expect(sourceDateFromPublishedTime("2024-03-15T23:00:00-05:00", NOW)).toBe("2024-03-16");
  });

  it("leaves the date absent when the input is missing or unparseable", () => {
    expect(sourceDateFromPublishedTime(undefined, NOW)).toBeUndefined();
    expect(sourceDateFromPublishedTime(null, NOW)).toBeUndefined();
    expect(sourceDateFromPublishedTime("", NOW)).toBeUndefined();
    expect(sourceDateFromPublishedTime("   ", NOW)).toBeUndefined();
    expect(sourceDateFromPublishedTime("yesterday", NOW)).toBeUndefined();
    expect(sourceDateFromPublishedTime("2024-13-01", NOW)).toBeUndefined();
  });

  it("rejects a date after today UTC and keeps today", () => {
    expect(sourceDateFromPublishedTime("2026-09-18T23:59:59.000Z", NOW)).toBe("2026-09-18");
    expect(sourceDateFromPublishedTime("2026-09-19T00:00:00.000Z", NOW)).toBeUndefined();
    expect(sourceDateFromPublishedTime("2026-09-19", NOW)).toBeUndefined();
  });

  it("rejects dates older than SOURCE_DATE_MIN and keeps the bound", () => {
    expect(sourceDateFromPublishedTime(SOURCE_DATE_MIN, NOW)).toBe(SOURCE_DATE_MIN);
    expect(sourceDateFromPublishedTime("1899-12-31", NOW)).toBeUndefined();
    expect(sourceDateFromPublishedTime("0001-01-01", NOW)).toBeUndefined();
  });
});

function mdWithFrontMatter(fields: string, body = "# Title\n\nbody"): string {
  return `---\n${fields}\n---\n${body}`;
}

describe("sourceDateFromMarkdownFrontMatter", () => {
  it("sets source_date from an explicit front-matter field", () => {
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("source_date: 2024-03-15"), NOW)).toBe(
      "2024-03-15",
    );
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("published: 2024-03-15"), NOW)).toBe(
      "2024-03-15",
    );
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("date: 2024-03-15"), NOW)).toBe(
      "2024-03-15",
    );
  });

  it("prefers source_date over published over date", () => {
    expect(
      sourceDateFromMarkdownFrontMatter(
        mdWithFrontMatter("date: 2020-01-01\npublished: 2021-01-01\nsource_date: 2024-03-15"),
        NOW,
      ),
    ).toBe("2024-03-15");
    expect(
      sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("date: 2020-01-01\npublished: 2021-01-01"), NOW),
    ).toBe("2021-01-01");
  });

  it("normalizes an offset timestamp to the UTC calendar date", () => {
    expect(
      sourceDateFromMarkdownFrontMatter(
        mdWithFrontMatter('source_date: "2024-03-15T23:00:00-05:00"'),
        NOW,
      ),
    ).toBe("2024-03-16");
  });

  it("omits source_date when front-matter is absent", () => {
    expect(sourceDateFromMarkdownFrontMatter("# Title\n\nbody", NOW)).toBeUndefined();
    expect(sourceDateFromMarkdownFrontMatter("**Date:** 2024-03-15\n\nbody", NOW)).toBeUndefined();
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("title: Untitled"), NOW)).toBeUndefined();
    expect(sourceDateFromMarkdownFrontMatter("---\nsource_date: 2024-03-15\n", NOW)).toBeUndefined();
  });

  it("omits source_date when the value is missing or implausible, without failing", () => {
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("source_date: yesterday"), NOW)).toBeUndefined();
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("source_date: 2099-01-01"), NOW)).toBeUndefined();
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("source_date: 1899-12-31"), NOW)).toBeUndefined();
    expect(sourceDateFromMarkdownFrontMatter(mdWithFrontMatter("source_date:"), NOW)).toBeUndefined();
    expect(
      sourceDateFromMarkdownFrontMatter(
        mdWithFrontMatter("source_date: not-a-date\ndate: 2024-03-15"),
        NOW,
      ),
    ).toBeUndefined();
  });
});

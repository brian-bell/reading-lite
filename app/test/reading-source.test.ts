import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import type { Reading } from "../src/reading";
import { demotedHeading, imagePlaceholder, sourceKnownUnavailable } from "../src/reading-source";
import { readingViewOf, searchForView, validateReadingSearch } from "../src/reading-view";

// The Source view's rules (#372), each a pure function so the component tests
// can assume them: which URL means Source, when the manifest already says the
// source is unavailable, what an image renders as before it is loaded, and
// where a source heading lands under the page title.

const readings = pack.readings as Record<string, Reading>;

describe("the view search parameter", () => {
  it("selects Source only for the exact value", () => {
    expect(validateReadingSearch({ view: "source" })).toEqual({ view: "source" });
    expect(readingViewOf({ view: "source" })).toBe("source");
  });

  // Acceptance matrix, Routes: "absent or any other value means Summary".
  it.each([{}, { view: "summary" }, { view: "Source" }, { view: "" }, { view: ["source"] }, { view: 1 }])(
    "reads %o as Summary and drops it from the URL",
    (search) => {
      expect(validateReadingSearch(search as Record<string, unknown>)).toEqual({});
      expect(readingViewOf(validateReadingSearch(search as Record<string, unknown>))).toBe("summary");
    },
  );

  it("writes Summary back as the URL without view", () => {
    expect(searchForView("summary")).toEqual({});
    expect(searchForView("source")).toEqual({ view: "source" });
  });
});

describe("sourceKnownUnavailable", () => {
  it("is true for the raw_only fixture and a failed capture", () => {
    expect(sourceKnownUnavailable(readings.rd_FXRAWSRC01!)).toBe(true);
    expect(sourceKnownUnavailable(readings.rd_FXERR00001!)).toBe(true);
  });

  it("is false for a captured source", () => {
    expect(sourceKnownUnavailable(readings.rd_FXATTENT01!)).toBe(false);
  });

  // An old manifest may carry no content_status; the request decides.
  it("is false when the manifest does not say", () => {
    expect(sourceKnownUnavailable({ id: "rd_1", url: "https://a.example/", status: "ready" })).toBe(false);
  });
});

describe("imagePlaceholder", () => {
  it("offers to load an https image and names its host as the metadata line would", () => {
    expect(imagePlaceholder("https://www.images.example/a/b.png?x=1")).toEqual({
      host: "images.example",
      loadable: true,
    });
  });

  // The CSP admits remote images over https: only, so an http: image would be
  // a blocked request; it keeps its placeholder and still says where it lives.
  it("names an http host without offering to load it", () => {
    expect(imagePlaceholder("http://images.example/a.png")).toEqual({ host: "images.example", loadable: false });
  });

  it.each(["/relative.png", "a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "", undefined])(
    "has nothing to load for %s",
    (src) => {
      expect(imagePlaceholder(src)).toEqual({ loadable: false });
    },
  );
});

describe("demotedHeading", () => {
  it("moves each level one down and stops at h6", () => {
    expect(demotedHeading("h1")).toBe("h2");
    expect(demotedHeading("h2")).toBe("h3");
    expect(demotedHeading("h3")).toBe("h4");
    expect(demotedHeading("h4")).toBe("h5");
    expect(demotedHeading("h5")).toBe("h6");
    expect(demotedHeading("h6")).toBe("h6");
  });
});

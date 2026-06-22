import { describe, expect, it } from "vitest";
import { buildYoutubeImport } from "../../../scripts/youtube-import-lib/parse";

const OEMBED = JSON.stringify({
  title: "5 Tips to Make You a PRO at Cursor",
  author_name: "Supabase",
  author_url: "https://www.youtube.com/@Supabase",
});

const WATCH_HTML =
  '<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"Learn five tips for Cursor."}};</script>';

describe("buildYoutubeImport", () => {
  it("renders title + author + description keyed by the canonical watch URL", () => {
    const req = buildYoutubeImport("https://youtu.be/YtTWNzOtkxU?t=30", {
      oembedJson: OEMBED,
      watchHtml: WATCH_HTML,
    });
    expect(req).not.toBeNull();
    expect(req!.source_url).toBe("https://www.youtube.com/watch?v=YtTWNzOtkxU");
    expect(req!.title).toBe("5 Tips to Make You a PRO at Cursor");
    expect(req!.markdown).toContain("# 5 Tips to Make You a PRO at Cursor");
    expect(req!.markdown).toContain("[Supabase](https://www.youtube.com/@Supabase)");
    expect(req!.markdown).toContain("Learn five tips for Cursor.");
    expect(req!.markdown).not.toContain("## Transcript");
  });

  it("includes a transcript section when transcript text is supplied", () => {
    const req = buildYoutubeImport("https://www.youtube.com/watch?v=YtTWNzOtkxU", {
      oembedJson: OEMBED,
      watchHtml: WATCH_HTML,
      transcript: "first tip second tip third tip",
    });
    expect(req!.markdown).toContain("## Transcript");
    expect(req!.markdown).toContain("first tip second tip third tip");
  });

  it("falls back to the oEmbed floor when the watch page is unavailable", () => {
    const req = buildYoutubeImport("https://www.youtube.com/watch?v=YtTWNzOtkxU", {
      oembedJson: OEMBED,
    });
    expect(req!.title).toBe("5 Tips to Make You a PRO at Cursor");
    expect(req!.markdown).toContain("# 5 Tips to Make You a PRO at Cursor");
    expect(req!.markdown).not.toContain("## Transcript");
  });

  it("returns null for a non-YouTube URL", () => {
    expect(buildYoutubeImport("https://example.com/watch?v=abc", { oembedJson: OEMBED })).toBeNull();
  });

  it("returns null when the oEmbed payload has no title", () => {
    expect(
      buildYoutubeImport("https://www.youtube.com/watch?v=YtTWNzOtkxU", { oembedJson: "{}" }),
    ).toBeNull();
  });
});

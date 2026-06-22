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

  it("truncates an oversized transcript so the queue message stays under the byte limit", () => {
    // The Worker forwards import markdown inside a Cloudflare queue message
    // (128 KB cap on the *whole* ProcessReadingArgs envelope, not the markdown
    // alone), so a long transcript must be trimmed with envelope headroom before
    // posting rather than 503-ing server-side after a reading is already claimed.
    const huge = "lorem ipsum dolor ".repeat(20_000); // ~360 KB
    const req = buildYoutubeImport("https://www.youtube.com/watch?v=YtTWNzOtkxU", {
      oembedJson: OEMBED,
      transcript: huge,
    });
    expect(req).not.toBeNull();
    // Leaves room for the serialized queue envelope under the 128 KB limit.
    expect(Buffer.byteLength(req!.markdown, "utf8")).toBeLessThanOrEqual(127_000);
    expect(req!.markdown).toContain("## Transcript");
    expect(req!.markdown).toContain("truncated");
  });

  it("does not split a multibyte character when truncating", () => {
    const huge = "café ".repeat(40_000); // multibyte é, ~280 KB
    const req = buildYoutubeImport("https://www.youtube.com/watch?v=YtTWNzOtkxU", {
      oembedJson: OEMBED,
      transcript: huge,
    });
    // A valid round-trip means no lone surrogate / replacement char was emitted.
    expect(req!.markdown).not.toContain("�");
    expect(Buffer.byteLength(req!.markdown, "utf8")).toBeLessThanOrEqual(128_000);
  });

  it("keeps a normal-sized transcript intact (no truncation notice)", () => {
    const req = buildYoutubeImport("https://www.youtube.com/watch?v=YtTWNzOtkxU", {
      oembedJson: OEMBED,
      transcript: "first tip second tip third tip",
    });
    expect(req!.markdown).toContain("first tip second tip third tip");
    expect(req!.markdown).not.toContain("truncated");
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

import { describe, expect, it } from "vitest";
import {
  buildYoutubeMarkdown,
  isYoutubeWatchUrl,
  parseOembed,
  parsePlayerResponse,
  parseVideoId,
  timedtextToText,
} from "../../../src/modules/extractor/youtube";

describe("isYoutubeWatchUrl / parseVideoId", () => {
  const watch: [string, string][] = [
    ["https://www.youtube.com/watch?v=YtTWNzOtkxU", "YtTWNzOtkxU"],
    ["https://youtube.com/watch?v=YtTWNzOtkxU&t=30s", "YtTWNzOtkxU"],
    ["https://m.youtube.com/watch?v=YtTWNzOtkxU", "YtTWNzOtkxU"],
    ["https://youtu.be/YtTWNzOtkxU", "YtTWNzOtkxU"],
    ["https://youtu.be/YtTWNzOtkxU?t=30", "YtTWNzOtkxU"],
    ["https://www.youtube.com/shorts/YtTWNzOtkxU", "YtTWNzOtkxU"],
    ["https://www.youtube.com/live/YtTWNzOtkxU", "YtTWNzOtkxU"],
    ["https://www.youtube-nocookie.com/embed/YtTWNzOtkxU", "YtTWNzOtkxU"],
  ];

  it.each(watch)("treats %s as a watchable video for id %s", (url, id) => {
    expect(isYoutubeWatchUrl(url)).toBe(true);
    expect(parseVideoId(url)).toBe(id);
  });

  const notWatch = [
    "https://www.youtube.com/",
    "https://www.youtube.com/results?search_query=cats",
    "https://www.youtube.com/@someChannel",
    "https://www.youtube.com/playlist?list=PLabc123",
    "https://example.com/watch?v=YtTWNzOtkxU",
    "not a url",
  ];

  it.each(notWatch)("does not treat %s as a watchable video", (url) => {
    expect(isYoutubeWatchUrl(url)).toBe(false);
    expect(parseVideoId(url)).toBeNull();
  });
});

describe("parsePlayerResponse", () => {
  // A trimmed real-shape watch page: the player response is assigned inline with
  // nested objects, an escaped quote + brace inside shortDescription, and a
  // captions tracklist. Brace-matching (not a greedy regex) must stop at the
  // object's true end, before the trailing `;var meta = {...}`.
  const HTML = `<!doctype html><html><head><title>x</title></head><body>
    <script>var ytInitialPlayerResponse = {"responseContext":{"a":{"b":1}},"videoDetails":{"videoId":"YtTWNzOtkxU","title":"Greeting \\"World\\"","shortDescription":"Line one {curly} and a \\"quote\\".\\nLine two."},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=YtTWNzOtkxU&lang=en","languageCode":"en","kind":"asr"},{"baseUrl":"https://www.youtube.com/api/timedtext?v=YtTWNzOtkxU&lang=es","languageCode":"es"}]}}};var meta = {"not":"this"};</script>
  </body></html>`;

  it("extracts description and caption track baseUrls", () => {
    const pr = parsePlayerResponse(HTML);
    expect(pr).not.toBeNull();
    expect(pr!.shortDescription).toBe('Line one {curly} and a "quote".\nLine two.');
    expect(pr!.captionTracks.map((t) => t.languageCode)).toEqual(["en", "es"]);
    expect(pr!.captionTracks[0]!.baseUrl).toContain("/api/timedtext?v=YtTWNzOtkxU&lang=en");
  });

  it("returns null when no player response is present", () => {
    expect(parsePlayerResponse("<html><body>no script here</body></html>")).toBeNull();
  });

  it("anchors on the assignment, ignoring earlier string mentions of the marker", () => {
    // Real watch HTML references the bare string `ytInitialPlayerResponse` in
    // config blobs BEFORE the actual `var ytInitialPlayerResponse = {…}`
    // assignment. A naive indexOf("ytInitialPlayerResponse") would grab the
    // wrong object and silently degrade to the title-only floor.
    const html =
      '<script>var cfg = {"key":"ytInitialPlayerResponse","opts":{"a":1}};</script>' +
      '<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"the real one"},' +
      '"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://x/t","languageCode":"en"}]}}};</script>';
    const pr = parsePlayerResponse(html);
    expect(pr).not.toBeNull();
    expect(pr!.shortDescription).toBe("the real one");
    expect(pr!.captionTracks).toHaveLength(1);
  });

  it("skips an empty-videoDetails decoy assignment for the substantive one", () => {
    const html =
      '<script>var ytInitialPlayerResponse = {"videoDetails":{}};</script>' +
      '<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"real one"}};</script>';
    expect(parsePlayerResponse(html)!.shortDescription).toBe("real one");
  });

  it("tolerates a player response without captions or description", () => {
    const html = `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc"}};</script>`;
    const pr = parsePlayerResponse(html);
    expect(pr).not.toBeNull();
    expect(pr!.shortDescription).toBeUndefined();
    expect(pr!.captionTracks).toEqual([]);
  });
});

describe("timedtextToText", () => {
  it("flattens fmt=json3 caption events", () => {
    const json3 = JSON.stringify({
      events: [
        { segs: [{ utf8: "Hello" }, { utf8: " there" }] },
        { segs: [{ utf8: "\n" }] },
        { segs: [{ utf8: "second line" }] },
        { segs: [{ utf8: "" }] },
      ],
    });
    expect(timedtextToText(json3)).toBe("Hello there second line");
  });

  it("flattens legacy XML caption text and decodes entities", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><transcript>' +
      '<text start="0" dur="2">Tom &amp; Jerry</text>' +
      '<text start="2" dur="2">it&#39;s &quot;great&quot;</text>' +
      "</transcript>";
    expect(timedtextToText(xml)).toBe('Tom & Jerry it\'s "great"');
  });

  it("returns empty string for unparseable input", () => {
    expect(timedtextToText("")).toBe("");
    expect(timedtextToText("garbage")).toBe("");
  });
});

describe("parseOembed", () => {
  it("reads title and author from an oEmbed JSON response", () => {
    const json = JSON.stringify({
      title: "Greeting World",
      author_name: "Some Channel",
      author_url: "https://www.youtube.com/@some",
      thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
    });
    expect(parseOembed(json)).toEqual({
      title: "Greeting World",
      authorName: "Some Channel",
      authorUrl: "https://www.youtube.com/@some",
    });
  });

  it("returns null when title is missing or body is unparseable", () => {
    expect(parseOembed(JSON.stringify({ author_name: "x" }))).toBeNull();
    expect(parseOembed("not json")).toBeNull();
  });
});

describe("buildYoutubeMarkdown", () => {
  const watchUrl = "https://www.youtube.com/watch?v=YtTWNzOtkxU";

  it("assembles title, author, description and transcript", () => {
    const md = buildYoutubeMarkdown({
      title: "Greeting World",
      authorName: "Some Channel",
      authorUrl: "https://www.youtube.com/@some",
      watchUrl,
      description: "A short description.",
      transcript: "hello there friends",
    });
    expect(md.startsWith("# Greeting World")).toBe(true);
    expect(md).toContain("[Some Channel](https://www.youtube.com/@some)");
    expect(md).toContain(`[Watch on YouTube](${watchUrl})`);
    expect(md).toContain("A short description.");
    expect(md).toContain("## Transcript");
    expect(md).toContain("hello there friends");
  });

  it("omits author link, description and transcript sections when absent (floor)", () => {
    const md = buildYoutubeMarkdown({ title: "Greeting World", watchUrl });
    expect(md).toContain("# Greeting World");
    expect(md).toContain(`[Watch on YouTube](${watchUrl})`);
    expect(md).not.toContain("## Transcript");
    expect(md).not.toContain("](https://www.youtube.com/@");
    expect(md.trim()).toBe(md);
  });
});

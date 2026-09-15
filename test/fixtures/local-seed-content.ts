// Authored article bodies for the local seed pack (issue #366). All content is
// fiction written for the Connected prototype (see
// docs/design/connected/design-spec.md#data-mapping and the authored samples in
// web/prototypes/interface-directions/samples.ts): no production corpus text,
// no real publications, no credentials. Fictional hosts use the reserved
// .example TLD; the YouTube fixture uses a reserved-style video id.
//
// Each entry provides the content artifacts one seeded reading writes to R2:
// the extracted Markdown (null when the reading is ready but the extractor
// produced no article body — the raw_only state) and the raw capture with the
// content type it was saved under.

export interface FixtureContent {
  /** Extracted article Markdown; null → content_status "raw_only" (no extracted.md object). */
  extractedMarkdown: string | null;
  raw: { body: string; contentType: string };
}

const html = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
</head>
<body>
<article>
${body}
</article>
</body>
</html>
`;

const h = (heading: string, text: string): string =>
  `<h2>${heading}</h2>\n<p>${text}</p>`;

const md = (sections: { heading: string; text: string }[]): string =>
  sections.map((s) => `## ${s.heading}\n\n${s.text}`).join("\n\n");

const ATTENTION_SECTIONS = [
  {
    heading: "Somewhere to return",
    text: "On a Sunday morning, I opened a folder of articles I had been meaning to read. There were hundreds of them. Every title represented a small promise to a future version of myself: you will have more time, and this will still matter. I closed the folder. Then I opened a single essay I had read a year earlier, and found the sentence I needed.",
  },
  {
    heading: "From collection to conversation",
    text: "We tend to build reading tools around the moment of capture. The button is frictionless, the queue infinite, the archive reassuring. But the important moment comes later. An old idea meets a new question. Two writers disagree in a way you can finally name. A library becomes useful when it can make those moments easier to find.",
  },
  {
    heading: "A little friction, in the right place",
    text: "A quieter tool does not have to be an empty tool. It can invite us to pause, compare, and follow one good connection. The distinction is whether the next action serves the thought we arrived with or replaces it. A link back to an earlier reading can deepen a session. A bottomless feed usually starts a different one.",
  },
  {
    heading: "Designing for enough",
    text: "Imagine a reading session that ends because you have understood something. No streak to maintain, no unfinished counter asking for attention. Just a clear summary, the source within reach, and perhaps one older piece worth returning to. We can make tools that respect this kind of ending. First, we have to decide that an ending is a success.",
  },
];

const GARDENS_SECTIONS = [
  {
    heading: "Tending an idea",
    text: "A warehouse promises to keep everything where you left it. A garden promises something different: what is here will change. Reading collections are closer to gardens. We pull ideas into new groupings, let some interests rest, and return to a familiar passage with a question we could not have asked last year.",
  },
  {
    heading: "Paths, not boxes",
    text: "A useful tag is a path you are likely to walk again. It does not need to describe an article completely. It only needs to help you return when a question becomes interesting. An imperfect collection that you visit will teach you more than a perfect one you only maintain.",
  },
];

const FRICTION_SECTIONS = [
  {
    heading: "A pause with a purpose",
    text: "A book club interrupts a book. So does a margin note. Neither is usually described as a failure of the reading experience. The pause can be the point: it asks us to make a thought our own. Digital tools can offer the same kind of interruption if they leave the reader in control.",
  },
  {
    heading: "Leave a way back",
    text: "A tangent becomes a distraction when the original question disappears. Keep the starting point visible. Explain why a connection might matter. Then allow the reader to follow it, or continue exactly where they were.",
  },
];

const SPARSE_SECTIONS = [
  {
    heading: "Available, not overdue",
    text: "An archive is not a promise to read everything in it. It is a resource for the questions you have now. When an article no longer serves a question, you can let it wait without turning it into a debt.",
  },
];

const LONG_TITLE_SECTIONS = [
  {
    heading: "The work around the work",
    text: "I spent an afternoon designing a better way to collect my writing ideas. When I finished, the ideas were beautifully arranged. None of them had become writing. Organization is not the enemy, but it is an activity with its own rewards. We need to notice when those rewards have replaced the reason we started.",
  },
];

const UNAVAILABLE_SECTIONS = [
  {
    heading: "A memory of pages",
    text: "The saved summary of a page that later moved behind a paywall is still a record of what it said. It is not the page. Keeping the two apart is part of maintaining an honest archive.",
  },
];

const MD_IMPORT_BODY = `# Slow reading week

A short log of one week spent reading three long pieces instead of thirty short ones.

## What changed

I kept a single question open for the whole week and read toward it. Notes went into one file, and each session ended by writing down what to look at next.

## What I noticed

- Starting was easier, because the question was already there.
- I reread two passages instead of opening new tabs.
- The summary I wrote on Friday was more useful than anything I saved that week.

## The log itself

Rich content an imported page can carry, for the Source view (#372): a table,
a code block, an image, raw HTML, and a link too long to break.

| Day | Piece | Pages | Note |
| --- | --- | --- | --- |
| Monday | The long essay on attention | 34 | Read twice; the second pass was the useful one |
| Wednesday | A field guide to commonplace books | 58 | Skimmed the history, read the method closely |
| Friday | An interview about slow tools | 21 | Wrote the summary straight after |

The script that pulled the week's notes together:

\`\`\`sh
for day in mon wed fri; do
  cat "notes/$day.md" >> week.md
done
wc -w week.md
\`\`\`

![The desk on Friday, three books and one notebook](https://images.fieldnotes.example/slow-reading-week/desk.jpg)

<img src="https://images.fieldnotes.example/pixel.gif" onerror="alert('imported')">

The full notes: <https://notes.fieldnotes.example/slow-reading-week/everything-i-wrote-down-during-the-week-including-the-parts-that-did-not-fit-anywhere-else-and-the-questions-i-am-still-holding>
`;

const YT_DESCRIPTION =
  "Chapter 4 of the build log. This week: why the reading queue is not a feed, and what it took to make the library feel like a place you can leave and come back to. Chapters: 0:00 intro, 2:14 the quiet-library idea, 7:40 queue vs. feed, 12:05 demo, 18:30 what broke.";

const YT_WATCH_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Building a quiet reading app — chapter 4 - YouTube</title>
</head>
<body>
<div id="watch">
<h1>Building a quiet reading app — chapter 4</h1>
<div id="description">${YT_DESCRIPTION}</div>
</div>
</body>
</html>
`;

export const FIXTURE_CONTENT: Record<string, FixtureContent> = {
  attention: {
    extractedMarkdown: md(ATTENTION_SECTIONS),
    raw: {
      body: html(
        "A quieter internet is a choice we can make",
        ATTENTION_SECTIONS.map((s) => h(s.heading, s.text)).join("\n"),
      ),
      contentType: "text/html; charset=utf-8",
    },
  },
  gardens: {
    extractedMarkdown: md(GARDENS_SECTIONS),
    raw: {
      body: html(
        "Libraries are gardens, not warehouses",
        GARDENS_SECTIONS.map((s) => h(s.heading, s.text)).join("\n"),
      ),
      contentType: "text/html; charset=utf-8",
    },
  },
  friction: {
    extractedMarkdown: md(FRICTION_SECTIONS),
    raw: {
      body: html(
        "The case for a little friction",
        FRICTION_SECTIONS.map((s) => h(s.heading, s.text)).join("\n"),
      ),
      contentType: "text/html; charset=utf-8",
    },
  },
  "sparse-archive": {
    extractedMarkdown: md(SPARSE_SECTIONS),
    raw: {
      body: html(
        "Against the endless queue",
        SPARSE_SECTIONS.map((s) => h(s.heading, s.text)).join("\n"),
      ),
      contentType: "text/html; charset=utf-8",
    },
  },
  "long-title": {
    extractedMarkdown: md(LONG_TITLE_SECTIONS),
    raw: {
      body: html(
        "What we lose when every tool for thinking becomes a place to organize, optimize, and measure the work instead of actually doing it",
        LONG_TITLE_SECTIONS.map((s) => h(s.heading, s.text)).join("\n"),
      ),
      contentType: "text/html; charset=utf-8",
    },
  },
  "unavailable-source": {
    // Ready, but the extractor produced no article body: raw capture only.
    // The summarizer ran on the "(non-text content; raw bytes saved at
    // raw.html)" prompt text, so the summary exists without extracted.md.
    extractedMarkdown: null,
    raw: {
      body: html(
        "The web we can no longer revisit",
        UNAVAILABLE_SECTIONS.map((s) => h(s.heading, s.text)).join("\n"),
      ),
      contentType: "text/html; charset=utf-8",
    },
  },
  "imported-markdown": {
    // Supplied Markdown import: the raw capture IS the markdown body
    // (content_type text/markdown), and extracted.md is the same text.
    extractedMarkdown: MD_IMPORT_BODY,
    raw: { body: MD_IMPORT_BODY, contentType: "text/markdown; charset=utf-8" },
  },
  "degraded-youtube": {
    // YouTube oEmbed floor with a successful watch page (description kept)
    // and a failed transcript fetch — enrichment_degradation tier
    // "transcript". The raw capture is the watch-page HTML.
    extractedMarkdown: [
      "# Building a quiet reading app — chapter 4",
      "*By [Quiet Build Studio](https://www.youtube.com/@quietbuildstudio) · [Watch on YouTube](https://www.youtube.com/watch?v=FxFixture01)*",
      YT_DESCRIPTION,
    ].join("\n\n"),
    raw: { body: YT_WATCH_HTML, contentType: "text/html; charset=utf-8" },
  },
  "old-manifest": {
    extractedMarkdown: md([
      {
        heading: "Why archive anything",
        text: "A saved page is a small bet that a future question will want it. This early note made the case for keeping the original text beside whatever summary replaces it.",
      },
    ]),
    raw: {
      body: html(
        "Before the archive",
        "<h2>Why archive anything</h2>\n<p>A saved page is a small bet that a future question will want it. This early note made the case for keeping the original text beside whatever summary replaces it.</p>",
      ),
      contentType: "text/html; charset=utf-8",
    },
  },
};

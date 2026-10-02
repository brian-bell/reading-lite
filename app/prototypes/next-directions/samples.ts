/**
 * Authored fiction shared by the three directions. The first six readings
 * are the bundled sample library (app/src/samples/sample-library.json), kept
 * in the manifest's own vocabulary (tldr, summary, tags, keywords, people,
 * orgs, novelty verdict, similarity count, connections, tensions); the rest
 * extend it so threads, tensions, a revisit prompt, an inbox, and the pending
 * and failed states have something to show. No production corpus, provider,
 * or backend is involved.
 */

export type Status = "ready" | "pending" | "failed";
export type Novelty = "novel" | "familiar" | "duplicate";
export type TensionKind = "contradicts" | "supersedes" | "superseded_by" | "qualifies" | "qualified_by";

export type Reading = {
  id: string;
  url: string;
  title: string;
  status: Status;
  /** ISO instant the reading was saved; the study clock is 2026-10-01T10:00Z. */
  createdAt: string;
  sourceType: "url" | "markdown";
  tags: string[];
  keywords: string[];
  people: string[];
  orgs: string[];
  tldr?: string;
  /** Paragraphs below the lead. */
  summary?: string[];
  novelty?: Novelty;
  /** `similarity.count` at processing time; 0 is the sparse-archive case. */
  similarityCount?: number;
  connections: { id: string; reason: string }[];
  tensions: { id: string; kind: TensionKind; reason: string }[];
  /** Extracted source; null when only the raw capture exists (`raw_only`). */
  source: { heading?: string; text: string }[] | null;
  /** A running attempt's stage, for pending readings. */
  stage?: string;
  /** When the running attempt started, for pending readings; the save time when absent. */
  attemptStartedAt?: string;
  /** The failure, for failed readings: the backend's error class or code and its stage. */
  error?: ReadingError;
  /**
   * The last finished attempt (the manifest's `last_attempt`). A ready
   * reading whose reprocess failed keeps its summary and content and carries
   * the failure here, never in `error`.
   */
  lastAttempt?: { trigger: "submit" | "reprocess" | "import"; status: "succeeded" | "failed"; finishedAt: string; error?: ReadingError };
};

export type ReadingError = { code: string; message: string; stage: string; httpStatus?: number };

export const STUDY_NOW = "2026-10-01T10:00:00Z";

/** Referenced by a connection but present nowhere: the removed-target case. */
export const REMOVED_TARGET_ID = "notes-on-the-attention-economy";

export const readings: Reading[] = [
  {
    id: "a-quieter-internet",
    url: "https://fieldnotes.example/2026/a-quieter-internet",
    title: "A quieter internet is a choice we can make",
    status: "ready",
    createdAt: "2026-09-28T08:12:00Z",
    sourceType: "url",
    tags: ["attention", "design"],
    keywords: ["attention", "deliberate reading", "personal library", "return visit", "tools for thought"],
    people: ["Mara Ellis"],
    orgs: ["Fieldnotes"],
    tldr: "The best tools for thought give us somewhere to return, not another stream to keep up with. A personal library can turn the internet from a demand on our attention into a place for deliberate reading.",
    summary: [
      "Saving is only the beginning. A library earns its place when it helps you return to an idea at the right moment — an old idea meeting a new question, or two writers whose disagreement you can finally name.",
      "Small, intentional interruptions can be useful: a connection to an older reading may matter more than another recommendation, as long as the reader stays in control of whether to follow it.",
      "The essay closes with a design criterion: measure a reading tool by the quality of its endings. A session that ends because you understood something is a success, not a failure to re-engage.",
    ],
    novelty: "familiar",
    similarityCount: 2,
    connections: [
      { id: "libraries-are-gardens", reason: "Both treat revisiting as the work. Ellis adds a concrete test: does the tool help an old idea meet a new question?" },
      { id: REMOVED_TARGET_ID, reason: "This earlier reading linked infinite feeds with unfinished tasks; Ellis answers it with a library that has endings." },
    ],
    tensions: [
      { id: "the-case-for-a-little-friction", kind: "contradicts", reason: "A stopping point protects attention; a deliberate interruption can deepen it. These essays disagree about where the default should sit." },
    ],
    source: [
      { heading: "Somewhere to return", text: "On a Sunday morning, I opened a folder of articles I had been meaning to read. There were hundreds of them. Every title represented a small promise to a future version of myself: you will have more time, and this will still matter. I closed the folder. Then I opened a single essay I had read a year earlier, and found the sentence I needed." },
      { heading: "The unit of value", text: "We measure reading tools by what they collect. A better measure is what they return: how often an old idea meets a new question because the tool put them in the same room. Collection is cheap. Return is the work, and almost nothing is designed for it." },
      { heading: "Endings", text: "A feed has no last item. A library can. The design criterion I keep coming back to is the quality of a session's ending: did it stop because I understood something, or because something else interrupted? Build for the first, and the second takes care of itself." },
    ],
  },
  {
    id: "the-case-for-a-little-friction",
    url: "https://adjacent.example/the-case-for-a-little-friction",
    title: "The case for a little friction",
    status: "ready",
    createdAt: "2026-09-26T17:40:00Z",
    sourceType: "url",
    tags: ["design"],
    keywords: ["friction", "interruption", "reading interfaces", "user control"],
    people: ["Leah Chen"],
    orgs: ["Adjacent"],
    tldr: "Not every interruption is a distraction. A deliberate pause or well-placed question can help a reader notice assumptions that a seamless interface would let pass.",
    summary: [
      "Useful interruption has a shape: it is relevant, optional, and easy to return from. Friction is useful when the reader understands its purpose.",
      "Leave the starting point visible and let the reader choose — that is the difference between a deepening tangent and a lost thread.",
    ],
    novelty: "familiar",
    similarityCount: 2,
    connections: [],
    tensions: [
      { id: "a-quieter-internet", kind: "contradicts", reason: "A stopping point protects attention; a deliberate interruption can deepen it. These essays disagree about where the default should sit." },
    ],
    source: [
      { heading: "Seamless is not the same as good", text: "The interfaces we praise are the ones we do not notice. But a reader who notices nothing also questions nothing. Some of the best moments in reading come from a pause that was put there on purpose." },
      { heading: "The shape of a useful interruption", text: "It is relevant to what you are reading. It is optional, so ignoring it costs nothing. And it is easy to return from: the place you left is still there when you come back. Most interruptions fail the third test, and that is why we distrust all of them." },
    ],
  },
  {
    id: "libraries-are-gardens",
    url: "https://commonplace.example/libraries-are-gardens",
    title: "Libraries are gardens, not warehouses",
    status: "ready",
    createdAt: "2026-09-20T11:05:00Z",
    sourceType: "url",
    tags: ["knowledge", "attention"],
    keywords: ["digital gardens", "archives", "revisiting", "tags", "note-taking"],
    people: ["Julian Park"],
    orgs: ["Commonplace Press"],
    tldr: "An archive grows more useful through care, not accumulation. Revisiting and connecting a small set of readings can do more for understanding than collecting a much larger set.",
    summary: [
      "Tags work as paths back into a question rather than a perfect classification system; an imperfect collection you visit teaches more than a perfect one you maintain.",
      "The maintenance itself is thinking: letting older readings change meaning as your interests change is the work the garden metaphor names.",
    ],
    novelty: "familiar",
    similarityCount: 2,
    connections: [
      { id: "a-quieter-internet", reason: "Ellis turns the garden metaphor into a design principle: optimize for a useful return visit." },
    ],
    tensions: [],
    source: [
      { heading: "Warehouses", text: "A warehouse is optimised for intake. Things arrive, get a label, and sit on a shelf until a forklift is sent for them. Most reading archives are warehouses: the better they get at receiving, the worse the backlog feels." },
      { heading: "Gardens", text: "A garden is optimised for return. You walk through it, and the walking is the point. Things you planted last spring look different this autumn because you are different. The maintenance is not overhead; it is the activity the garden exists for." },
    ],
  },
  {
    id: "the-tab-that-never-closes",
    url: "https://fieldnotes.example/the-tab-that-never-closes",
    title: "The tab that never closes",
    status: "ready",
    createdAt: "2026-09-29T21:30:00Z",
    sourceType: "url",
    tags: ["attention"],
    keywords: ["browser tabs", "saving", "deferral", "reading later"],
    people: ["Mara Ellis"],
    orgs: ["Fieldnotes"],
    tldr: "An open tab is a promise, not a plan. Saving a reading gives it somewhere to wait without asking for attention, so the tab can close and the piece can come back when it matters.",
    summary: [
      "The essay separates saving from deferring: a saved reading has a place to be, while an open tab is an unpaid debt in the corner of the screen.",
    ],
    novelty: "familiar",
    similarityCount: 1,
    connections: [
      { id: "a-quieter-internet", reason: "Both essays treat saving as a way to end a session well rather than to defer it." },
    ],
    tensions: [],
    source: [
      { text: "There is a tab in my browser that has been open since March. I know what it is. I know I will not read it today. I also know that closing it feels like giving up on it, which is why it is still there." },
      { heading: "A place to be", text: "A saved reading is not a deferred one. Deferral keeps the obligation and loses the context. Saving keeps the context and drops the obligation. The tab can close; the piece will be where I left it, with the reason I kept it." },
    ],
  },
  {
    id: "slow-reading-week",
    url: "https://notes.example/slow-reading-week",
    title: "Slow reading week",
    status: "ready",
    createdAt: "2026-09-24T07:55:00Z",
    sourceType: "markdown",
    tags: ["notes", "reading"],
    keywords: ["slow reading", "reading log", "single question", "note-taking"],
    people: [],
    orgs: [],
    tldr: "A one-week experiment in reading three long pieces instead of thirty short ones, kept as a single log with one standing question.",
    summary: [
      "Starting was easier with the question already open; rereading replaced new tabs; and the Friday summary proved more useful than anything saved that week.",
    ],
    novelty: "novel",
    similarityCount: 1,
    connections: [
      { id: "a-quieter-internet", reason: "The week's standing question came from Ellis's argument for deliberate reading." },
    ],
    tensions: [],
    source: [
      { heading: "Monday", text: "Standing question: what makes a reading session end well? Read the first long piece. Reread the last section twice. Did not open anything else." },
      { heading: "Wednesday", text: "Second piece. Noticed I wanted to save three things from it and instead wrote one sentence in the log. The sentence was better than the three saves would have been." },
      { heading: "Friday", text: "Third piece, then this summary. The question did more work than any of the readings. Next week: same question, different three." },
    ],
  },
  {
    id: "against-the-endless-queue",
    url: "https://small-hours.example/against-the-endless-queue",
    title: "Against the endless queue",
    status: "ready",
    createdAt: "2026-09-14T22:10:00Z",
    sourceType: "url",
    tags: ["attention"],
    keywords: ["reading queue", "unread articles", "archives", "obligation"],
    people: ["Alex Rivera"],
    orgs: ["Small Hours"],
    tldr: "A reading queue can become a list of obligations. Rivera proposes keeping a small set of active interests and allowing the rest to remain an archive.",
    summary: [
      "An unread item does not have to be an unfinished task; a saved article can be available without being a commitment.",
    ],
    novelty: "novel",
    similarityCount: 0,
    connections: [],
    tensions: [],
    source: [
      { text: "The queue was supposed to help. Instead it became a second inbox, with the same guilt and none of the replies. Here is what I do now: three active interests at a time. Everything else goes in the archive, where it is available and silent." },
    ],
  },
  {
    id: "what-a-commonplace-book-is-for",
    url: "https://commonplace.example/what-a-commonplace-book-is-for",
    title: "What a commonplace book is for",
    status: "ready",
    createdAt: "2026-09-18T09:20:00Z",
    sourceType: "url",
    tags: ["knowledge", "notes"],
    keywords: ["commonplace book", "excerpts", "rereading", "memory"],
    people: ["Ines Halvorsen"],
    orgs: ["Commonplace Press"],
    tldr: "A commonplace book is not a filing system but a record of what moved you, kept so that rereading it changes what you notice next.",
    summary: [
      "Halvorsen traces the form from Renaissance notebooks to the present and argues that its value was never retrieval. The excerpts were chosen for their pull, and the act of copying them was the point.",
      "The modern mistake is to optimise the book for finding things. A commonplace book you can search is a database; one you reread is a practice.",
    ],
    novelty: "familiar",
    similarityCount: 2,
    connections: [
      { id: "on-marginalia", reason: "Halvorsen's excerpts and the marginal notes in the earlier essay are the same practice seen from two sides: what you copy out and what you write back." },
    ],
    tensions: [
      { id: "the-second-brain-is-a-filing-cabinet", kind: "qualified_by", reason: "Reyes accepts that rereading matters but argues retrieval is what makes rereading possible at scale. Halvorsen treats retrieval as the distraction." },
    ],
    source: [
      { heading: "Not a filing system", text: "The commonplace books that survive are not well organised. They are well loved. Passages sit next to each other because they were copied on the same afternoon, and the accidental neighbours are where the thinking happened." },
      { heading: "Copying as reading", text: "To copy a passage by hand is to read it at the speed of writing. Nothing you can search for will give you that. The book is a record of attention, and rereading it is attention paid twice." },
    ],
  },
  {
    id: "the-second-brain-is-a-filing-cabinet",
    url: "https://adjacent.example/the-second-brain-is-a-filing-cabinet",
    title: "The second brain is a filing cabinet",
    status: "ready",
    createdAt: "2026-09-22T14:00:00Z",
    sourceType: "url",
    tags: ["knowledge"],
    keywords: ["second brain", "retrieval", "note systems", "rereading"],
    people: ["Tomas Reyes"],
    orgs: ["Adjacent"],
    tldr: "Note systems promise a second brain and deliver a filing cabinet. That is fine, Reyes argues, as long as you open the drawers: retrieval is what lets rereading happen at all once the notes outgrow memory.",
    summary: [
      "The essay defends search and structure against the romance of the notebook. A practice you cannot find your way back into is a practice you will stop.",
      "Reyes concedes the notebook's point about attention, then asks what happens in year five, when the pages number in the thousands.",
    ],
    novelty: "familiar",
    similarityCount: 1,
    connections: [],
    tensions: [
      { id: "what-a-commonplace-book-is-for", kind: "qualifies", reason: "Reyes accepts that rereading matters but argues retrieval is what makes rereading possible at scale. Halvorsen treats retrieval as the distraction." },
    ],
    source: [
      { heading: "Open the drawers", text: "A filing cabinet is only useless if you never open it. The systems that fail are not the ones with too much structure; they are the ones whose owners stopped looking inside. Structure is what makes looking cheap enough to keep doing." },
    ],
  },
  {
    id: "on-marginalia",
    url: "https://commonplace.example/on-marginalia",
    title: "On marginalia",
    status: "ready",
    createdAt: "2026-03-02T19:45:00Z",
    sourceType: "url",
    tags: ["reading", "notes"],
    keywords: ["marginalia", "annotation", "rereading", "paper"],
    people: ["Ines Halvorsen"],
    orgs: ["Commonplace Press"],
    tldr: "Marginal notes are a conversation with a book that the next reading overhears. Halvorsen argues they matter more than the highlights that replaced them.",
    summary: [
      "A highlight records that something mattered; a note records why. On the second reading only the second kind is useful, because the first has lost its context.",
    ],
    novelty: "novel",
    similarityCount: 0,
    connections: [
      { id: "what-a-commonplace-book-is-for", reason: "Halvorsen's excerpts and the marginal notes in the earlier essay are the same practice seen from two sides: what you copy out and what you write back." },
    ],
    tensions: [],
    source: [
      { text: "I found a copy of a book I had read at twenty, with my own handwriting in the margins. The notes were wrong about almost everything, and they were the most useful thing in the book, because they told me exactly what I had been looking for." },
    ],
  },
  {
    id: "reading-on-paper-again",
    url: "https://small-hours.example/reading-on-paper-again",
    title: "Reading on paper, again",
    status: "ready",
    createdAt: "2026-09-10T06:30:00Z",
    sourceType: "url",
    tags: ["reading"],
    keywords: ["paper", "printing", "long reads", "distraction"],
    people: ["Alex Rivera"],
    orgs: ["Small Hours"],
    tldr: "A month of printing every long read. Rivera reports slower reading, fewer saves, and a surprising number of finished pieces.",
    summary: [
      "Paper removed the option to save for later: the piece was either read or recycled. Rivera suggests the constraint, not the medium, did the work.",
    ],
    novelty: "novel",
    similarityCount: 1,
    connections: [
      { id: "slow-reading-week", reason: "Both are constraint experiments: fewer pieces, one at a time, with the option to defer removed." },
    ],
    tensions: [],
    source: [
      { text: "For a month I printed everything over two thousand words. The printer became a kind of editor: if a piece was not worth the paper, I did not read it. Most were not. The ones that were, I finished." },
    ],
  },
  {
    id: "reading-as-conversation",
    url: "https://commonplace.example/reading-as-conversation",
    title: "Reading as conversation",
    status: "ready",
    createdAt: "2026-09-16T10:30:00Z",
    sourceType: "url",
    tags: ["knowledge", "reading"],
    keywords: ["conversation", "rereading", "annotation", "dialogue"],
    people: ["Julian Park"],
    orgs: ["Commonplace Press"],
    tldr: "A book read twice is a conversation with the earlier reader. Park argues that a library should make the earlier reader easy to find.",
    summary: [
      "The essay treats each reading as a reply to the last one, and a library as the record of the exchange. What matters is not the collection but the ability to find what you said last time.",
    ],
    novelty: "familiar",
    similarityCount: 1,
    connections: [
      { id: "libraries-are-gardens", reason: "Park's conversation and the garden are the same claim about return visits, made with different images." },
    ],
    tensions: [],
    source: [
      { text: "The second time through a book you are not alone. Someone read it before you, and left a trail: a folded corner, a line in the margin, a sentence you now remember wrongly. That someone was you." },
    ],
    // A reprocess that failed at the fetch: the summary and content above are
    // the earlier attempt's and stay; the manifest keeps status ready and
    // carries the failure as `last_attempt` (fixture `reprocess-failed`).
    lastAttempt: {
      trigger: "reprocess",
      status: "failed",
      finishedAt: "2026-10-01T09:50:00Z",
      error: { code: "BadStatusError", message: "The page returned 403.", stage: "fetch_source", httpStatus: 403 },
    },
  },
  {
    id: "the-cost-of-convenience",
    url: "https://adjacent.example/the-cost-of-convenience",
    title: "The cost of convenience",
    status: "pending",
    // Saved 40 minutes before the study clock with its attempt still at the
    // fetch: past the 15-minute pending window, so a read surfaces it as
    // failed (`stale_pending`) without a write (fixture `fail-stopped`'s
    // read-time cousin).
    createdAt: "2026-10-01T09:20:00Z",
    sourceType: "url",
    tags: [],
    keywords: [],
    people: [],
    orgs: [],
    connections: [],
    tensions: [],
    source: null,
    stage: "fetch_source",
  },
  {
    id: "why-we-skim",
    url: "https://fieldnotes.example/why-we-skim",
    title: "Why we skim",
    status: "pending",
    createdAt: "2026-10-01T09:52:00Z",
    sourceType: "url",
    tags: [],
    keywords: [],
    people: [],
    orgs: [],
    connections: [],
    tensions: [],
    source: null,
    stage: "summarize",
  },
  {
    id: "interface-budgets",
    url: "https://adjacent.example/interface-budgets",
    title: "Interface budgets",
    status: "failed",
    createdAt: "2026-10-01T09:40:00Z",
    sourceType: "url",
    tags: [],
    keywords: [],
    people: [],
    orgs: [],
    connections: [],
    tensions: [],
    source: null,
    error: { code: "provider_key_invalid", message: "OpenAI rejected the key.", stage: "summarize", httpStatus: 401 },
  },
];

export type InboxItem = {
  id: string;
  url: string;
  title: string | null;
  bytes: number;
  stagedAt: string;
  markdown: string;
};

export const inboxItems: InboxItem[] = [
  {
    id: "in_log",
    url: "https://notes.example/how-to-keep-a-reading-log",
    title: "How to keep a reading log",
    bytes: 4120,
    stagedAt: "2026-10-01T08:15:00Z",
    markdown: "# How to keep a reading log\n\nOne file. One line per reading: date, title, and the sentence you would say to a friend about it.\n\nNo ratings. No tags at first. Tags arrive when you notice the same word three times.",
  },
  {
    id: "in_talk",
    url: "https://small-hours.example/talks/attention-2026/transcript",
    title: null,
    bytes: 18432,
    stagedAt: "2026-09-30T19:02:00Z",
    markdown: "Transcript, lightly edited.\n\nThank you. I want to talk about the difference between a queue and an archive, and why the first one makes us miserable…",
  },
];

/** What a thread, an index, or a search can say about a reading's status. */
export function statusLabel(reading: Reading): string | undefined {
  if (reading.status === "pending") return "Processing";
  if (reading.status === "failed") return "Failed";
  return undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "7 September 2026", as the production app formats a date (UTC, en-GB). */
export function dateOn(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

/** "about 7 months ago", "3 days ago", "today": for revisit prompts and the desk. */
export function agoLabel(iso: string, now = STUDY_NOW): string {
  const days = Math.floor((Date.parse(now) - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "about a month ago" : `about ${months} months ago`;
}

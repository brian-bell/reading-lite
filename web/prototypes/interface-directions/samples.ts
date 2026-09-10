/** Authored fiction shared by all three directions. No production corpus or APIs. */
export type Reading = {
  id: string;
  title: string;
  author: string;
  publication: string;
  date: string;
  minutes: number;
  tags: string[];
  status: "ready" | "pending" | "failed";
  summary: string;
  points: string[];
  novelty: string;
  source: { heading: string; text: string }[] | null;
  connections: { target: string; kind: "connection" | "tension"; title: string; reason: string }[];
};

export const readings: Reading[] = [
  {
    id: "attention", title: "A quieter internet is a choice we can make", author: "Mara Ellis",
    publication: "Fieldnotes", date: "Sep 7, 2026", minutes: 8, tags: ["Attention", "Design"], status: "ready",
    summary: "The best tools for thought give us somewhere to return, not another stream to keep up with. A personal library can turn the internet from a demand on our attention into a place for deliberate reading.",
    points: [
      "Saving is only the beginning. A library earns its place when it helps you return to an idea at the right moment.",
      "Small, intentional interruptions can be useful: a connection to an older reading may matter more than another recommendation.",
      "Design for a sense of enough. Clear stopping points let a reading session feel complete."
    ],
    novelty: "A familiar argument for slower tools, with a useful shift: the unit of value is the return visit, not the saved article. This extends your readings on attention with a practical design criterion.",
    source: [
      { heading: "Somewhere to return", text: "On a Sunday morning, I opened a folder of articles I had been meaning to read. There were hundreds of them. Every title represented a small promise to a future version of myself: you will have more time, and this will still matter. I closed the folder. Then I opened a single essay I had read a year earlier, and found the sentence I needed." },
      { heading: "From collection to conversation", text: "We tend to build reading tools around the moment of capture. The button is frictionless, the queue infinite, the archive reassuring. But the important moment comes later. An old idea meets a new question. Two writers disagree in a way you can finally name. A library becomes useful when it can make those moments easier to find." },
      { heading: "A little friction, in the right place", text: "A quieter tool does not have to be an empty tool. It can invite us to pause, compare, and follow one good connection. The distinction is whether the next action serves the thought we arrived with or replaces it. A link back to an earlier reading can deepen a session. A bottomless feed usually starts a different one." },
      { heading: "Designing for enough", text: "Imagine a reading session that ends because you have understood something. No streak to maintain, no unfinished counter asking for attention. Just a clear summary, the source within reach, and perhaps one older piece worth returning to. We can make tools that respect this kind of ending. First, we have to decide that an ending is a success." },
    ],
    connections: [
      { target: "gardens", kind: "connection", title: "Libraries are gardens, not warehouses", reason: "Both treat revisiting as the work. Ellis adds a concrete test: does the tool help an old idea meet a new question?" },
      { target: "friction", kind: "tension", title: "The case for a little friction", reason: "Ellis favors clear stopping points; Chen argues that a productive interruption can be exactly what a reader needs. The useful distinction is who chooses the interruption." },
      { target: "deleted", kind: "connection", title: "Notes on the attention economy", reason: "This earlier reading linked infinite feeds with unfinished tasks. The reading has since been removed; this explanation remains for context." },
    ],
  },
  {
    id: "gardens", title: "Libraries are gardens, not warehouses", author: "Julian Park", publication: "Commonplace",
    date: "Sep 4, 2026", minutes: 6, tags: ["Knowledge", "Attention"], status: "ready",
    summary: "An archive grows more useful through care, not accumulation. Revisiting and connecting a small set of readings can do more for understanding than collecting a much larger set.",
    points: ["Treat tags as paths back into a question, not a perfect classification system.", "Let older readings change meaning as your interests change.", "Return to one saved idea before adding ten new ones."],
    novelty: "Reinforces your interest in deliberate reading. The gardening metaphor makes maintenance feel like part of thinking, rather than a separate administrative task.",
    source: [{ heading: "Tending an idea", text: "A warehouse promises to keep everything where you left it. A garden promises something different: what is here will change. Reading collections are closer to gardens. We pull ideas into new groupings, let some interests rest, and return to a familiar passage with a question we could not have asked last year." }, { heading: "Paths, not boxes", text: "A useful tag is a path you are likely to walk again. It does not need to describe an article completely. It only needs to help you return when a question becomes interesting. An imperfect collection that you visit will teach you more than a perfect one you only maintain." }],
    connections: [{ target: "attention", kind: "connection", title: "A quieter internet is a choice we can make", reason: "Ellis turns the garden metaphor into a design principle: optimize for a useful return visit." }],
  },
  {
    id: "friction", title: "The case for a little friction", author: "Leah Chen", publication: "Adjacent", date: "Sep 2, 2026", minutes: 5, tags: ["Design"], status: "ready",
    summary: "Not every interruption is a distraction. A deliberate pause or well-placed question can help a reader notice assumptions that a seamless interface would let pass.",
    points: ["Friction is useful when the reader understands its purpose.", "A question at the right moment can turn passive reading into active comparison.", "Give people control over when they follow a tangent."],
    novelty: "Challenges the assumption that less friction always improves reading. Adds a criterion for useful interruption: it should be relevant, optional, and easy to return from.",
    source: [{ heading: "A pause with a purpose", text: "A book club interrupts a book. So does a margin note. Neither is usually described as a failure of the reading experience. The pause can be the point: it asks us to make a thought our own. Digital tools can offer the same kind of interruption if they leave the reader in control." }, { heading: "Leave a way back", text: "A tangent becomes a distraction when the original question disappears. Keep the starting point visible. Explain why a connection might matter. Then allow the reader to follow it, or continue exactly where they were." }],
    connections: [{ target: "attention", kind: "tension", title: "A quieter internet is a choice we can make", reason: "A stopping point protects attention; a deliberate interruption can deepen it. These essays disagree about where the default should sit." }],
  },
  {
    id: "long-title", title: "What we lose when every tool for thinking becomes a place to organize, optimize, and measure the work instead of actually doing it", author: "Theo Morgan", publication: "Working Notes", date: "Aug 29, 2026", minutes: 12, tags: ["Knowledge", "Design"], status: "ready",
    summary: "The systems around creative work can quietly become the work itself. A useful tool makes it easier to begin, and knows when to get out of the way.",
    points: ["Measure whether a system helps you begin the actual task.", "Reconsider routines that create more maintenance than insight."],
    novelty: "Mostly familiar territory in this sample archive. The distinction between preparation and avoidance gives the argument a sharper edge.",
    source: [{ heading: "The work around the work", text: "I spent an afternoon designing a better way to collect my writing ideas. When I finished, the ideas were beautifully arranged. None of them had become writing. Organization is not the enemy, but it is an activity with its own rewards. We need to notice when those rewards have replaced the reason we started." }], connections: [],
  },
  {
    id: "unavailable", title: "The web we can no longer revisit", author: "Nora Vale", publication: "Margin", date: "Aug 25, 2026", minutes: 7, tags: ["Knowledge"], status: "ready",
    summary: "As pages disappear or move behind access restrictions, saved summaries become a partial memory of the web. They are useful, but cannot replace the original evidence.",
    points: ["A saved summary and a captured source have different roles.", "Show missing source content explicitly so readers can judge what is still available."],
    novelty: "Adds the problem of source durability to the archive-maintenance theme. The summary is preserved, but the captured source is unavailable in this sample.", source: null,
    connections: [{ target: "gardens", kind: "connection", title: "Libraries are gardens, not warehouses", reason: "Maintaining a library also means acknowledging what has been lost." }],
  },
  {
    id: "pending", title: "Making room for slow work", author: "Mara Ellis", publication: "Fieldnotes", date: "Sep 7, 2026", minutes: 4, tags: ["Attention"], status: "pending",
    summary: "Slow work needs a small, protected beginning. The essay proposes choosing one question, limiting the inputs, and leaving a useful note for the next session.",
    points: ["Start with one question worth staying with.", "End with a note that makes returning easier."], novelty: "Adds a practical routine to the quieter-tools argument: preserve the thread of a question between sessions.",
    source: [{ heading: "A place to begin again", text: "The hardest part of slow work is often returning to it. Before ending a session, write down the question that still interests you. Keep the next step small. Tomorrow does not need a complete plan; it needs somewhere to begin." }],
    connections: [{ target: "attention", kind: "connection", title: "A quieter internet is a choice we can make", reason: "Applies the return-visit principle to a daily practice." }],
  },
  {
    id: "failed", title: "Against the endless queue", author: "Alex Rivera", publication: "Small Hours", date: "Sep 6, 2026", minutes: 6, tags: ["Attention"], status: "failed",
    summary: "A reading queue can become a list of obligations. Rivera proposes keeping a small set of active interests and allowing the rest to remain an archive.",
    points: ["An unread item does not have to be an unfinished task.", "Keep the current reading list small enough to choose from."], novelty: "A practical complement to designing for enough: let a saved article be available without making it a commitment.",
    source: [{ heading: "Available, not overdue", text: "An archive is not a promise to read everything in it. It is a resource for the questions you have now. When an article no longer serves a question, you can let it wait without turning it into a debt." }], connections: [],
  },
];

export const directions = [
  { id: "editorial", letter: "A", name: "Editorial reader", short: "Editorial", description: "Settle into one reading. A spacious page puts the source and summary first; connections wait at the end." },
  { id: "workbench", letter: "B", name: "Library workbench", short: "Workbench", description: "Move through the archive. Dense lists and a persistent reading pane keep search, status, and capture close." },
  { id: "connected", letter: "C", name: "Connected reading", short: "Connected", description: "Read ideas in company. Connections and tensions sit beside the article, with a clear path back from every detour." },
] as const;
export type Direction = typeof directions[number]["id"];

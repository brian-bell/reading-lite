import { Link } from "@tanstack/react-router";
import { useId, type ReactNode } from "react";
import { carryReturn } from "../library-return";
import {
  connectionsComputedOn,
  relationshipCards,
  targetStatusBadge,
  type RelationshipCard,
} from "../reading-relationships";
import { trailAfterFollowing, type ReadingRoute, type TrailHop } from "../reading-trail";
import type { Reading } from "../reading";
import { savedOn } from "../reading-presentation";
import type { SimilarReading } from "../similar-readings";
import { revisitPrompts, type Thread } from "../threads";
import { Icon } from "./Icon";
import { jumpTo } from "./jump-to";
import { useTrail } from "./ReturnTrail";

// Connections and tensions beside the reading (#371; design spec: Relationship
// targets, Components, Keyboard, focus, and motion). On desktop the context
// column sits beside the article. On phones it follows the reading: the
// "Connections & tensions" jump moves focus to this section's heading, and
// "Back to the reading" returns focus to the jump link. Neither changes the
// URL or adds a history entry, and both scroll smoothly only when motion is
// welcome (jump-to.ts).
//
// Above the cards, the thread strip names the reading's thread and links the
// readings either side of it (reading-lite-kl7y.3). The page passes `thread`
// once the relationship graph has loaded in the browser and the reading is in
// a thread; until then, and when the read fails, there is no strip. After the
// cards, Worth revisiting lists the connections saved long before this
// reading, and More like this the nearest readings no judge has placed beside
// it yet (reading-lite-kl7y.5). The reading page passes `similar` once it has
// loaded in the browser; the sample pages never do.

export const CONTEXT_HEADING_ID = "context-heading";
export const CONTEXT_JUMP_ID = "context-jump";

/** The phone-only jump link in the reading column. */
export function ContextJump() {
  return (
    <a
      id={CONTEXT_JUMP_ID}
      className="context-jump"
      href={`#${CONTEXT_HEADING_ID}`}
      onClick={(event) => jumpTo(event, CONTEXT_HEADING_ID)}
    >
      Connections &amp; tensions
    </a>
  );
}

/**
 * `route` is where a relationship card leads: another reading in the library,
 * or, on the sample library's pages, another sample.
 */
export function ReadingContext({
  reading,
  route = "/readings/$id",
  thread,
  similar = [],
}: {
  reading: Reading;
  route?: ReadingRoute;
  thread?: Thread;
  similar?: readonly SimilarReading[];
}) {
  const { connections, tensions } = relationshipCards(reading);
  const computed = connectionsComputedOn(reading);
  const from = { id: reading.id, title: reading.title ?? reading.url };
  const revisits = revisitPrompts(reading).map(
    (prompt): RelationshipCard => ({
      id: prompt.id,
      kind: "connection",
      label: savedOn(prompt.createdAt),
      reason: prompt.reason,
      target: { title: prompt.title, url: prompt.url, status: "ready" },
    }),
  );
  return (
    <aside className="reading-context" aria-labelledby={CONTEXT_HEADING_ID}>
      <h2 id={CONTEXT_HEADING_ID} className="context-heading" tabIndex={-1}>
        Connections &amp; tensions
      </h2>
      {thread ? <ThreadStrip thread={thread} readingId={reading.id} /> : null}
      {connections.length > 0 ? (
        <RelationshipGroup heading="Connections" note={computed} cards={connections} from={from} route={route} />
      ) : null}
      {tensions.length > 0 ? <RelationshipGroup heading="Tensions" cards={tensions} from={from} route={route} /> : null}
      {revisits.length > 0 ? (
        <RelationshipGroup heading="Worth revisiting" cards={revisits} from={from} route={route} revisit />
      ) : null}
      {similar.length > 0 ? (
        <ContextGroup heading="More like this" note="By similarity alone, not yet judged for a connection.">
          {similar.map((item) => (
            <SimilarCard key={item.id} reading={item} />
          ))}
        </ContextGroup>
      ) : null}
      <a className="context-return" href={`#${CONTEXT_JUMP_ID}`} onClick={(event) => jumpTo(event, CONTEXT_JUMP_ID)}>
        Back to the reading
      </a>
    </aside>
  );
}

function RelationshipGroup({
  heading,
  note,
  cards,
  from,
  route,
  revisit = false,
}: {
  heading: string;
  note?: string;
  cards: RelationshipCard[];
  from: { id: string; title: string };
  route: ReadingRoute;
  revisit?: boolean;
}) {
  return (
    <ContextGroup heading={heading} note={note}>
      {cards.map((card) => (
        <RelationshipCardView key={`${card.kind}:${card.id}`} card={card} from={from} route={route} revisit={revisit} />
      ))}
    </ContextGroup>
  );
}

function ContextGroup({ heading, note, children }: { heading: string; note?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="relationship-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{heading}</h3>
      {note ? <p className="relationship-note">{note}</p> : null}
      {children}
    </section>
  );
}

/**
 * A plain link that keeps the way back to the list, not a FollowLink: a
 * similarity is not a relationship, so it is no hop on the return trail.
 */
function SimilarCard({ reading }: { reading: SimilarReading }) {
  return (
    <article className="relationship-card relationship-card-similar">
      <p className="relationship-title">
        <Link to="/readings/$id" params={{ id: reading.id }} state={carryReturn}>
          {reading.title}
        </Link>
      </p>
      {reading.tldr ? <p className="relationship-reason">{reading.tldr}</p> : null}
    </article>
  );
}

/**
 * One card: kind label, title (a link to the target when it exists), reason,
 * and a text status badge for a target that is not ready. A removed target has
 * no title to show and nowhere to go; its reason stays, dashed, because the
 * explanation is still true of this reading.
 */
function RelationshipCardView({
  card,
  from,
  route,
  revisit,
}: {
  card: RelationshipCard;
  from: { id: string; title: string };
  route: ReadingRoute;
  revisit: boolean;
}) {
  const tension = card.kind === "tension";
  const removed = card.target === undefined;
  const className = [
    "relationship-card",
    tension ? "relationship-card-tension" : "",
    removed ? "relationship-card-removed" : "",
    revisit ? "relationship-card-revisit" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const kindLabel = removed ? "Reading removed" : card.label;
  return (
    <article className={className}>
      {kindLabel ? <p className="relationship-kind">{kindLabel}</p> : null}
      {card.target ? (
        <p className="relationship-title">
          <FollowLink card={card} from={from} route={route} />
          {targetStatusBadge(card.target.status) ? (
            <span className={`status-badge status-badge-${card.target.status}`}>
              {targetStatusBadge(card.target.status)}
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="relationship-reason">{card.reason}</p>
    </article>
  );
}

function FollowLink({
  card,
  from,
  route,
}: {
  card: RelationshipCard;
  from: { id: string; title: string };
  route: ReadingRoute;
}) {
  const current = useTrail();
  const hop: TrailHop = { id: from.id, title: from.title, kind: card.kind, reason: card.reason };
  return (
    <Link
      to={route}
      params={{ id: card.id }}
      state={(prev) => ({ ...carryReturn(prev), trail: trailAfterFollowing(current, hop) })}
    >
      {card.target!.title}
    </Link>
  );
}

/**
 * The reading's thread and the readings either side of it, oldest first:
 * Earlier then Later, each a link, or a plain end marker at the thread's ends.
 */
function ThreadStrip({ thread, readingId }: { thread: Thread; readingId: string }) {
  const index = thread.readings.findIndex((reading) => reading.id === readingId);
  const earlier = thread.readings[index - 1];
  const later = thread.readings[index + 1];
  return (
    <nav className="thread-strip" aria-label="Thread">
      <p className="thread-strip-name">
        <Icon name="thread" size={14} strokeWidth={2} /> In{" "}
        <Link to="/threads/$id" params={{ id: thread.id }}>
          {thread.name}
        </Link>{" "}
        · {index + 1} of {thread.readings.length}
      </p>
      <div className="thread-strip-steps">
        <ThreadStep label="Earlier" reading={earlier} end="This is the first" />
        <ThreadStep label="Later" reading={later} end="This is the latest" />
      </div>
    </nav>
  );
}

function ThreadStep({ label, reading, end }: { label: string; reading?: Thread["readings"][number]; end: string }) {
  if (!reading) {
    return (
      <span className="thread-step thread-step-empty">
        <span className="thread-step-label">{label}</span>
        {end}
      </span>
    );
  }
  return (
    <Link to="/readings/$id" params={{ id: reading.id }} className="thread-step">
      <span className="thread-step-label">{label}</span>
      {reading.title ?? reading.url}
    </Link>
  );
}

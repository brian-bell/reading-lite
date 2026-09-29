import { Link } from "@tanstack/react-router";
import { useId } from "react";
import {
  connectionsComputedOn,
  relationshipCards,
  targetStatusBadge,
  type RelationshipCard,
} from "../reading-relationships";
import { trailAfterFollowing, type TrailHop } from "../reading-trail";
import type { Reading } from "../reading";
import { jumpTo } from "./jump-to";
import { useTrail } from "./ReturnTrail";

// Connections and tensions beside the reading (#371; design spec: Relationship
// targets, Components, Keyboard, focus, and motion). On desktop the context
// column sits beside the article. On phones it follows the reading: the
// "Connections & tensions" jump moves focus to this section's heading, and
// "Back to the reading" returns focus to the jump link. Neither changes the
// URL or adds a history entry, and both scroll smoothly only when motion is
// welcome (jump-to.ts).

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

export function ReadingContext({ reading }: { reading: Reading }) {
  const { connections, tensions } = relationshipCards(reading);
  const computed = connectionsComputedOn(reading);
  const from = { id: reading.id, title: reading.title ?? reading.url };
  return (
    <aside className="reading-context" aria-labelledby={CONTEXT_HEADING_ID}>
      <h2 id={CONTEXT_HEADING_ID} className="context-heading" tabIndex={-1}>
        Connections &amp; tensions
      </h2>
      {connections.length > 0 ? (
        <RelationshipGroup heading="Connections" note={computed} cards={connections} from={from} />
      ) : null}
      {tensions.length > 0 ? <RelationshipGroup heading="Tensions" cards={tensions} from={from} /> : null}
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
}: {
  heading: string;
  note?: string;
  cards: RelationshipCard[];
  from: { id: string; title: string };
}) {
  const headingId = useId();
  return (
    <section className="relationship-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{heading}</h3>
      {note ? <p className="relationship-note">{note}</p> : null}
      {cards.map((card) => (
        <RelationshipCardView key={`${card.kind}:${card.id}`} card={card} from={from} />
      ))}
    </section>
  );
}

/**
 * One card: kind label, title (a link to the target when it exists), reason,
 * and a text status badge for a target that is not ready. A removed target has
 * no title to show and nowhere to go; its reason stays, dashed, because the
 * explanation is still true of this reading.
 */
function RelationshipCardView({ card, from }: { card: RelationshipCard; from: { id: string; title: string } }) {
  const tension = card.kind === "tension";
  const removed = card.target === undefined;
  const className = ["relationship-card", tension ? "relationship-card-tension" : "", removed ? "relationship-card-removed" : ""]
    .filter(Boolean)
    .join(" ");
  const kindLabel = removed ? "Reading removed" : card.label;
  return (
    <article className={className}>
      {kindLabel ? <p className="relationship-kind">{kindLabel}</p> : null}
      {card.target ? (
        <p className="relationship-title">
          <FollowLink card={card} from={from} />
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

/**
 * Following a relationship pushes a hop onto the trail the current location
 * carries, so the destination can say where the reader came from and why.
 * The way back to the library (library-return.ts) is carried on as it is, and
 * nothing else: a save notice belongs to the reading it was left on.
 */
function FollowLink({ card, from }: { card: RelationshipCard; from: { id: string; title: string } }) {
  const current = useTrail();
  const hop: TrailHop = { id: from.id, title: from.title, kind: card.kind, reason: card.reason };
  return (
    <Link
      to="/readings/$id"
      params={{ id: card.id }}
      state={(prev) => ({ libraryReturn: prev?.libraryReturn, trail: trailAfterFollowing(current, hop) })}
    >
      {card.target!.title}
    </Link>
  );
}

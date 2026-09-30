import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { previousHop, trailAfterReturning, trailOf, type ReadingRoute, type TrailHop } from "../reading-trail";
import { useRenderedLocation } from "./rendered-location";

// The return trail above a reading reached by following a relationship
// (design spec, Return trail): the previous title and reason, and a way back.
//
// "Back to {title}" is the browser's Back when there is history to go back
// through, so the previous reading comes back with its own trail and scroll
// position, exactly as the Back button would. Without that history (the
// reader arrived here by a link whose state was set elsewhere) it is a link to
// the previous reading carrying the trail popped by one hop, and the way back
// to the library (library-return.ts) unchanged.

/**
 * The trail of the page on screen (useRenderedLocation): while a followed
 * reading is in flight the page being left would otherwise show the trail
 * meant for the next one, and a second click would push it twice.
 */
export function useTrail(): readonly TrailHop[] {
  return useRenderedLocation((location) => trailOf(location.state));
}

/** `route` is where the previous hop lives: a reading, or on the sample library's pages, a sample. */
export function ReturnTrail({ hops, route = "/readings/$id" }: { hops: readonly TrailHop[]; route?: ReadingRoute }) {
  const previous = previousHop(hops);
  if (!previous) return null;
  return (
    <nav className="reading-trail" aria-label="Return trail">
      <BackTo hops={hops} previous={previous} className="reading-trail-back" route={route} />
      <p className="reading-trail-context">
        You followed a {previous.kind} from <strong>{previous.title}</strong>.
      </p>
      <p className="reading-trail-reason">{previous.reason}</p>
    </nav>
  );
}

export function BackTo({
  hops,
  previous,
  className,
  route = "/readings/$id",
}: {
  hops: readonly TrailHop[];
  previous: TrailHop;
  className?: string;
  route?: ReadingRoute;
}) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const label = `Back to ${previous.title}`;
  if (canGoBack) {
    return (
      <button type="button" className={className} onClick={() => router.history.back()}>
        {label}
      </button>
    );
  }
  return (
    <Link
      className={className}
      to={route}
      params={{ id: previous.id }}
      state={(prev) => ({ libraryReturn: prev?.libraryReturn, trail: trailAfterReturning(hops) })}
    >
      {label}
    </Link>
  );
}

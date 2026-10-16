import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { carryReturn } from "../library-return";
import { previousHop, trailAfterReturning, trailOf, type ReadingRoute, type TrailHop } from "../reading-trail";
import { useRenderedLocation } from "./rendered-location";

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
      state={(prev) => ({ ...carryReturn(prev), trail: trailAfterReturning(hops) })}
    >
      {label}
    </Link>
  );
}

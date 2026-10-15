import { Link, useRouter } from "@tanstack/react-router";
import { libraryReturnDelta } from "../library-return";
import { useRenderedLocation } from "./rendered-location";

// "Back to library" (#407; library-return.ts). With a library entry behind
// this one in this document load it goes back through history to that entry,
// so the library returns with its filters, page, and scroll position, as
// browser Back would — past any readings followed since. Otherwise (a direct
// link, a reload, the server render) it is a link to `/library`.
//
// Both values come from the page on screen (useRenderedLocation): while a
// followed reading is in flight the history position is already the next
// entry's, and the distance back would be off by one.

export function BackToLibrary({ className }: { className?: string }) {
  const router = useRouter();
  const delta = useRenderedLocation((location) => libraryReturnDelta(location.state));
  if (delta !== undefined) {
    return (
      <button type="button" className={className} onClick={() => router.history.go(delta)}>
        Back to library
      </button>
    );
  }
  return (
    <Link className={className} to="/library">
      Back to library
    </Link>
  );
}

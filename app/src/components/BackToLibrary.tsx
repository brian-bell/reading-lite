import { Link, useRouter } from "@tanstack/react-router";
import { RETURN_LABEL, readingReturn } from "../library-return";
import { useRenderedLocation } from "./rendered-location";

// "Back to library" or "Back to catalog" (#407; library-return.ts). With that
// list entry behind this one in this document load it goes back through
// history to that entry, so the list returns with its filters, page, and
// scroll position, as browser Back would, past any readings followed since.
// Otherwise (a direct link, a reload, the server render) it is a link to
// `/library` labeled "Back to library".
//
// Both values come from the page on screen (useRenderedLocation): while a
// followed reading is in flight the history position is already the next
// entry's, and the distance back would be off by one.

export function BackToLibrary({ className }: { className?: string }) {
  const router = useRouter();
  const back = useRenderedLocation((location) => readingReturn(location.state));
  if (back !== undefined) {
    return (
      <button type="button" className={className} onClick={() => router.history.go(back.delta)}>
        {RETURN_LABEL[back.origin]}
      </button>
    );
  }
  return (
    <Link className={className} to="/library">
      {RETURN_LABEL.library}
    </Link>
  );
}

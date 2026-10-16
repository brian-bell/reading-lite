import { Link, useRouter } from "@tanstack/react-router";
import { RETURN_LABEL, readingReturn } from "../library-return";
import { useRenderedLocation } from "./rendered-location";

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

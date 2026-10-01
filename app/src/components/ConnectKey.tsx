import { Link } from "@tanstack/react-router";
import { KEY_REQUIRED_SENTENCE } from "../capture-refusal";

// The way to the provider page from wherever a missing key stops a reader
// (reading-lite-gh341.11): the empty library, /save before a first save, and
// any capture write the backend refused for want of a key.

export function ConnectKeyLink({ primary = false }: { primary?: boolean }) {
  return (
    <Link to="/account/provider" className={primary ? "button button-primary" : "button"}>
      Connect a key
    </Link>
  );
}

/**
 * Said above /save's form while the reader has no key, so the first thing
 * they learn is what to do rather than that a save was refused.
 */
export function ConnectKeyPrompt() {
  return (
    <aside className="callout" aria-label="Connect a key">
      <p>{KEY_REQUIRED_SENTENCE}</p>
      <ConnectKeyLink primary />
    </aside>
  );
}

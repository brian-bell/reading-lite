import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, type ReactNode } from "react";
import { accountViewOf } from "../account-state";
import type { Identity } from "../identity";
import type { KeyStep } from "../onboarding";
import { providerQueryOptions } from "../provider-query";
import { Icon } from "./Icon";
import { KEY_CONNECTED_SENTENCE, ProviderKeySection } from "./ProviderKey";
import { InlineNotice, LoadingRegion } from "./ReadingStates";

// The new reader's three steps (reading-lite-kl7y.9), a view of the desk's
// mode (onboarding.ts). Step 1 opens the samples and has no done state:
// nothing records that a sample was opened. Step 2 is the provider page's
// own key section. Step 3 is held until a key is connected. Its status
// region says so when it opens, since focus stays in the key form.

export function Onboarding({ keyStep, identity }: { keyStep: KeyStep; identity: Identity }) {
  const headingId = useId();
  const keyHintId = useId();
  const connected = keyStep === "connected";
  return (
    <section className="onboarding" aria-labelledby={headingId}>
      <h2 id={headingId} className="desk-section-title">
        Three steps to your first reading
      </h2>
      <ol className="onboarding-steps">
        <Step mark={1} done={false} title="See how a processed reading looks">
          <p className="form-hint">
            Each sample has a summary, a novelty verdict, and connections to the others.{" "}
            <Link to="/samples">Open the samples</Link>
          </p>
        </Step>
        <Step mark={2} done={connected} title="Connect your OpenAI key">
          <p id={keyHintId} className="form-hint">
            Summaries and embeddings run with it; you pay OpenAI directly. Saving is off until a key is connected.
          </p>
          <KeyStepForm identity={identity} />
        </Step>
        <Step mark={3} done={false} title="Save your first reading">
          <p className="form-hint">Your first reading has nothing to connect to yet; the second one will.</p>
          {connected ? (
            <Link to="/save" className="button button-primary">
              Save a reading
            </Link>
          ) : (
            <button type="button" className="button" aria-disabled="true" aria-describedby={keyHintId}>
              Save a reading
            </button>
          )}
          <p className="form-status" role="status">
            {connected ? KEY_CONNECTED_SENTENCE : null}
          </p>
        </Step>
      </ol>
    </section>
  );
}

function Step({ mark, done, title, children }: { mark: 1 | 2 | 3; done: boolean; title: string; children: ReactNode }) {
  return (
    <li className={done ? "onboarding-step onboarding-done" : "onboarding-step"}>
      <span className="onboarding-mark" aria-hidden="true">
        {done ? <Icon name="check" size={14} strokeWidth={2.2} /> : mark}
      </span>
      <div>
        <p className="onboarding-title">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** Step 2's form, from the browser's provider read, as the desk's provider tile reads it. */
function KeyStepForm({ identity }: { identity: Identity }) {
  const queryClient = useQueryClient();
  const provider = useQuery(providerQueryOptions(queryClient, identity));
  const view = accountViewOf({ data: provider.data, error: provider.error, fetchStatus: provider.fetchStatus });
  if (view.kind === "loading") return <LoadingRegion className="desk-tile-meta" />;
  const settings = view.kind === "ready" || view.kind === "offline" ? view.value : undefined;
  if (settings) return <ProviderKeySection settings={settings} next={null} />;
  return (
    <InlineNotice message="Provider settings aren't available right now." onAction={() => void provider.refetch()} />
  );
}

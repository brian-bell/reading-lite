import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, type ReactNode } from "react";
import { accountViewOf, type AccountView } from "../account-state";
import type { Identity } from "../identity";
import { keyStepOf, type KeyPresence, type KeyStep } from "../onboarding";
import type { ProviderSettings } from "../provider";
import { providerQueryOptions } from "../provider-query";
import { Icon } from "./Icon";
import { KEY_CONNECTED_SENTENCE, ProviderKeySection } from "./ProviderKey";
import { InlineNotice, LoadingRegion } from "./ReadingStates";

export function Onboarding({ keyStep, identity }: { keyStep: KeyStep; identity: Identity }) {
  const queryClient = useQueryClient();
  const provider = useQuery(providerQueryOptions(queryClient, identity));
  const view = accountViewOf({ data: provider.data, error: provider.error, fetchStatus: provider.fetchStatus });
  const headingId = useId();
  const keyHintId = useId();
  const connected = keyStepOf(keyStep, keyPresenceOf(view)) === "connected";
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
          <KeyStepForm view={view} onRetry={() => void provider.refetch()} />
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

function settingsOf(view: AccountView<ProviderSettings>): ProviderSettings | undefined {
  return view.kind === "ready" || view.kind === "offline" ? view.value : undefined;
}

function keyPresenceOf(view: AccountView<ProviderSettings>): KeyPresence {
  const settings = settingsOf(view);
  if (settings === undefined) return "unknown";
  return settings.credential === null ? "absent" : "present";
}

function KeyStepForm({ view, onRetry }: { view: AccountView<ProviderSettings>; onRetry: () => void }) {
  if (view.kind === "loading") return <LoadingRegion className="desk-tile-meta" />;
  const settings = settingsOf(view);
  if (settings) return <ProviderKeySection settings={settings} next={null} />;
  return <InlineNotice message="Provider settings aren't available right now." onAction={onRetry} />;
}

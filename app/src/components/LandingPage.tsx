import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { SAMPLE_READINGS } from "../samples";
import { LoginLegalLinks } from "./LegalPages";
import { PageHeading } from "./PageHeading";
import { SampleCard } from "./SamplePages";
import { SignInForm } from "./SignInPage";

export function LandingPage() {
  const signInId = useId();
  const samplesId = useId();
  return (
    <div className="page landing">
      <div className="landing-head">
        <PageHeading>Reading Lite summarizes what you save and connects it to what you have already read.</PageHeading>
        <p className="auth-lede">
          Save an article. Get its summary, what it adds to your library, and the readings it agrees or argues with.
          Your own OpenAI key does the work; the library is yours.
        </p>
      </div>
      <div className="landing-columns">
        <section className="landing-signin" aria-labelledby={signInId}>
          <h2 id={signInId} className="landing-section-title">
            Sign in
          </h2>
          <p className="form-hint">We’ll email you a sign-in link. No password needed.</p>
          <SignInForm next="/" />
          <p className="form-hint">
            After signing in you connect an OpenAI key, then save your first reading. Until then the samples show what
            a processed reading looks like.
          </p>
          <LoginLegalLinks />
        </section>
        <section className="landing-samples" aria-labelledby={samplesId}>
          <h2 id={samplesId} className="landing-section-title">
            Sample library
          </h2>
          <ul className="library-list" aria-label="Sample readings">
            {SAMPLE_READINGS.map((reading) => (
              <SampleCard key={reading.id} reading={reading} level={3} />
            ))}
          </ul>
          <Link to="/samples" className="button">
            Browse samples
          </Link>
        </section>
      </div>
    </div>
  );
}

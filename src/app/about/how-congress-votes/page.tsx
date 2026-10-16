import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How Congress Votes — Govroll",
  description:
    "Not every bill gets a recorded roll-call vote. A plain-English guide to voice votes, unanimous consent, and suspension of the rules — and what it means when your representative's vote isn't listed.",
};

export default function HowCongressVotesPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-10">
      <header className="space-y-3">
        <p className="text-ink-muted flex items-center gap-2 text-[11px] font-bold tracking-[0.18em] uppercase">
          <span className="brand-node" aria-hidden="true" />
          About
        </p>
        <h1 className="text-4xl font-bold tracking-tight">
          How Congress votes — and why some bills show no votes.
        </h1>
        <p className="text-ink-muted text-base leading-relaxed">
          A bill can become law without any member of Congress casting an
          individual, recorded vote. That&apos;s not a bug in our data —
          that&apos;s how Congress works. Here&apos;s what the different vote
          methods mean.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Recorded roll-call vote</h2>
        <p className="text-ink-muted text-base leading-relaxed">
          Each member&apos;s &quot;yea&quot; or &quot;nay&quot; is recorded by
          name. This is the only vote method that produces the kind of
          individual-level voting record most people picture. It&apos;s required
          by the Constitution for a handful of actions (like overriding a veto)
          and can be demanded by any one-fifth of members present.
        </p>
        <p className="text-ink-muted text-base leading-relaxed">
          When you see a specific vote like &quot;Yes&quot; or &quot;No&quot; on
          a bill page, it came from a recorded roll call.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Voice vote</h2>
        <p className="text-ink-muted text-base leading-relaxed">
          The presiding officer asks members to say &quot;aye&quot; or
          &quot;no&quot; in unison. Whichever side is louder wins. No individual
          names are recorded. Voice votes are typical for uncontroversial bills
          — renaming a post office, recognizing a historic event, technical
          corrections — where demanding a full roll call would waste floor time
          nobody wants to waste.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Unanimous consent</h2>
        <p className="text-ink-muted text-base leading-relaxed">
          A member asks the chamber to agree to something without an objection.
          If no one objects, it&apos;s done — no vote of any kind. The Senate in
          particular runs almost its entire schedule this way. If a single
          senator objects, unanimous consent fails and the matter has to go
          through normal procedure.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Suspension of the rules</h2>
        <p className="text-ink-muted text-base leading-relaxed">
          The House uses this for fast-tracking bills that have broad support.
          It requires a two-thirds majority to pass, so it&apos;s mostly used
          for bills everyone agrees on. When a suspension vote is uncontested,
          it passes by voice vote with no individual record. When even one
          member demands a roll call, it switches to a recorded vote.
        </p>
      </section>

      <section id="procedural" className="scroll-mt-24 space-y-3">
        <h2 className="text-xl font-semibold">Procedural votes</h2>
        <p className="text-ink-muted text-base leading-relaxed">
          Before (or instead of) a final passage vote, the chamber often records
          votes on procedural steps:
        </p>
        <ul className="text-ink-muted list-disc space-y-2 pl-5 text-base leading-relaxed">
          <li>
            <strong className="text-ink">Motion to proceed</strong> —
            &quot;let&apos;s start debating this bill.&quot; A Yes is a signal
            the member wants the bill taken up.
          </li>
          <li>
            <strong className="text-ink">Motion to discharge</strong> —
            &quot;pull this bill out of committee and onto the floor.&quot; Used
            when a committee is sitting on a bill. A Yes is a direct signal the
            member wants the bill to get a vote.
          </li>
          <li>
            <strong className="text-ink">Cloture</strong> — &quot;end the
            filibuster so we can actually vote.&quot; Needs 60 Senate votes. A
            Yes is a signal the member wants to move to final passage.
          </li>
          <li>
            <strong className="text-ink">Motion to table</strong> — &quot;set
            this aside, effectively killing it.&quot; A Yes is effectively a No
            on the bill.
          </li>
          <li>
            <strong className="text-ink">Motion to recommit</strong> —
            &quot;send it back to committee for changes.&quot; Usually a delay
            or kill tactic from the minority party.
          </li>
        </ul>
        <p className="text-ink-muted text-base leading-relaxed">
          Because each procedural motion means something different, Govroll
          labels these votes as &quot;on a procedural step&quot; rather than
          guessing what the motion implied. The vote itself is real — it&apos;s
          the interpretation that needs care.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Why this matters</h2>
        <p className="text-ink-muted text-base leading-relaxed">
          Roughly four out of five bills that Congress enacts pass at least one
          chamber without a recorded roll call. That&apos;s why a bill page
          might show &quot;enacted&quot; at the top but no individual votes from
          your representatives. It doesn&apos;t mean they skipped the vote. It
          means the vote method Congress chose didn&apos;t record names.
        </p>
        <p className="text-ink-muted text-base leading-relaxed">
          Govroll is working on showing more signals — did your representative
          cosponsor the bill, speak for or against it, or sponsor an amendment?
          — so that &quot;no recorded vote&quot; doesn&apos;t mean &quot;no
          information at all.&quot;
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">
          Did not vote vs. no recorded vote
        </h2>
        <p className="text-ink-muted text-base leading-relaxed">
          These sound similar but are different:
        </p>
        <ul className="text-ink-muted list-disc space-y-2 pl-5 text-base leading-relaxed">
          <li>
            <strong className="text-ink">Did not vote</strong> — the chamber
            held a recorded roll call and your representative wasn&apos;t
            present (or was present but didn&apos;t cast a vote). This is an
            individual fact about them.
          </li>
          <li>
            <strong className="text-ink">No recorded vote</strong> — the chamber
            didn&apos;t hold a roll call at all. This is a fact about how the
            bill was passed, not about your representative.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Sources</h2>
        <p className="text-ink-muted text-base leading-relaxed">
          Our vote data comes straight from the official roll-call records
          published by the Clerk of the House and the U.S. Senate, and bill
          details come from Congress.gov. For deeper reading, the Congressional
          Research Service publishes plain-English explainers of{" "}
          <a
            href="https://www.congress.gov/crs-product/98-314"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sapphire-deep underline underline-offset-2"
          >
            suspension of the rules
          </a>{" "}
          and{" "}
          <a
            href="https://www.congress.gov/crs-product/RS20594"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sapphire-deep underline underline-offset-2"
          >
            unanimous consent
          </a>
          .
        </p>
      </section>

      <div className="border-t pt-4">
        <Link
          href="/about"
          className="text-sapphire-deep text-sm underline underline-offset-2"
        >
          ← Back to About
        </Link>
      </div>
    </div>
  );
}

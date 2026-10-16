import { ExternalLink } from "lucide-react";

/**
 * Vertical "Sources" attribution block for the reader's outline rail
 * (desktop) and outline sheet (mobile). Shows where the bill text comes
 * from with deep links so readers can verify against the official source.
 *
 * Congress.gov is canonical (the upstream of truth). GovTrack used to be
 * listed alongside it, until govtrack.us began putting visitors through a
 * bot check (Oct 2026). "Source:" framing — not "View on" — to honor
 * Govroll's role as a presentation layer over official government data.
 */
export function SourceLinks({
  congressGovUrl,
}: {
  congressGovUrl: string | null;
}) {
  if (!congressGovUrl) return null;
  return (
    <div className="text-xs">
      <p className="text-ink-muted mb-2 px-2 text-[11px] font-bold tracking-[0.18em] uppercase">
        Sources
      </p>
      <ul className="space-y-1">
        <li>
          <SourceLink href={congressGovUrl} label="Congress.gov" />
        </li>
      </ul>
    </div>
  );
}

function SourceLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sapphire-deep inline-flex w-full items-center gap-1.5 px-2 py-1 underline-offset-2 transition-colors hover:underline"
    >
      <span>{label}</span>
      <ExternalLink className="h-3 w-3 opacity-70" aria-hidden="true" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

import Link from "next/link";
import { billHref } from "@/lib/bills/url";

/**
 * Friendly state for when a bill has no usable text yet (and therefore
 * nothing to render in the reader). The page-level RSC is responsible
 * for kicking off `maybeFetchBillTextInBackground` so a refresh in a
 * minute or two will likely succeed; here we just explain and offer
 * the user a path back to the engagement page.
 */
export function TextNotAvailable({
  bill,
}: {
  bill: {
    billId: string;
    title: string;
    /** Display headline. Falls back to `title` when omitted. */
    headline?: string;
    link?: string | null;
  };
}) {
  return (
    <div className="bg-paper min-h-screen">
      {/* An empty reader shouldn't be indexed. React hoists this into
          <head>; bills that will never get text 404 before reaching here. */}
      <meta name="robots" content="noindex" />
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="text-ink text-2xl font-semibold sm:text-3xl">
          {bill.headline ?? bill.title}
        </h1>
        <div className="border-hollow mx-auto mt-8 max-w-lg border-[1.5px] border-dashed px-6 py-8">
          <p className="text-ink-muted text-[11px] font-bold tracking-[0.18em] uppercase">
            Text not yet available
          </p>
          <p className="text-ink-muted mt-4 text-sm leading-relaxed">
            Congress.gov has not published machine-readable text for this bill
            in our system yet. We&apos;re fetching it in the background — check
            back in a few minutes, or read the bill on Congress.gov directly.
          </p>
        </div>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={billHref(bill)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center px-4 text-sm font-medium transition-colors"
          >
            Back to bill page
          </Link>
          {bill.link ? (
            <a
              href={bill.link}
              target="_blank"
              rel="noopener noreferrer"
              className="border-rule text-ink hover:bg-muted inline-flex h-10 items-center justify-center border px-4 text-sm font-medium transition-colors"
            >
              View on Congress.gov ↗
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

import { ImageResponse } from "next/og";
import { prisma } from "@/lib/prisma";
import { parseBillPath, billIdentifierFor } from "@/lib/bills/url";
import { pickBillHeadline } from "@/lib/bill-headline";
import { formatBillNumber } from "@/lib/bill-grouping";
import { getStatusExplanation } from "@/lib/bill-helpers";
import { formatOrdinal } from "@/lib/parse-bill-citation";

export const alt = "Govroll bill share";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FONT_URL =
  "https://cdn.jsdelivr.net/fontsource/fonts/archivo@latest/latin-800-normal.woff";

// Let Vercel's CDN keep the rendered card. ImageResponse otherwise sends
// `max-age=0, must-revalidate`, so every link unfurl (Slack, X, iMessage) and
// crawler fetch re-ran the DB query, the font download and the PNG render
// (~2.5s per request) against the free tier's Active CPU budget. A share card
// whose status line is up to a week stale is fine.
const CACHE_CONTROL =
  "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";

// One font download per warm instance instead of one per render. A failed
// fetch clears the slot so the next render retries.
let archivoFont: Promise<ArrayBuffer> | null = null;
function loadArchivoFont(): Promise<ArrayBuffer> {
  archivoFont ??= fetch(FONT_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`font fetch failed: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .catch((err: unknown) => {
      archivoFont = null;
      throw err;
    });
  return archivoFont;
}

// Roll Call palette — the card uses sand/ink/sapphire only, plus the one
// gold node on the route motif.
const SAND = "#F2EDE3";
const INK = "#14161C";
const SAPPHIRE = "#4164FF";
const SAPPHIRE_DEEP = "#3258FF";
const GOLD = "#FFB62E";

// Hard cap so a procedural-title fallback ("To amend the Internal Revenue
// Code of 1986 to provide for…") still lays out cleanly. At 64px in the
// 1040px content width, ~22 chars fit per line, so 110 caps at ~5 lines —
// past that the bottom status row gets clipped.
const HEADLINE_HARD_CAP = 110;

function clampHeadline(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const idx = lastSpace > max * 0.6 ? lastSpace : max - 1;
  return cut.slice(0, idx).replace(/[,;:]\s*$/, "") + "…";
}

// Tuned for legibility at thumbnail sizes (iMessage ~300px, Twitter ~506px).
// Source font sizes scale down by ~3-4× in those previews, so the floor is
// 64px — anything smaller becomes mush.
function headlineFontSize(text: string): number {
  const len = text.length;
  if (len <= 24) return 128;
  if (len <= 50) return 104;
  if (len <= 90) return 80;
  return 64;
}

/** Six-dot route motif: cleared sapphire stops, one gold "current" node,
 *  hollow (outlined) stops ahead. Purely decorative — no status encoding. */
function RouteMotif() {
  const dot = (key: number, style: React.CSSProperties) => (
    <div
      key={key}
      style={{
        display: "flex",
        width: 18,
        height: 18,
        borderRadius: 9999,
        ...style,
      }}
    />
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
      {dot(0, { backgroundColor: SAPPHIRE })}
      {dot(1, { backgroundColor: SAPPHIRE })}
      <div
        style={{
          display: "flex",
          width: 26,
          height: 26,
          borderRadius: 9999,
          backgroundColor: GOLD,
        }}
      />
      {dot(3, { border: `3px solid ${SAPPHIRE}` })}
      {dot(4, { border: `3px solid ${SAPPHIRE}` })}
      {dot(5, { border: `3px solid ${SAPPHIRE}` })}
    </div>
  );
}

type Params = Promise<{
  congress: string;
  chamber: string;
  numberSlug: string;
}>;

export default async function OgImage({ params }: { params: Params }) {
  // Kicked off before the DB lookup so the two overlap. A CDN hiccup falls
  // back to the default font rather than failing the whole image.
  const fontPromise = loadArchivoFont().catch(() => null);

  const { congress, chamber, numberSlug } = await params;
  const parsed = parseBillPath([congress, chamber, numberSlug]);
  const billIdKey = parsed
    ? billIdentifierFor(parsed.chamberCode, parsed.number, parsed.congress)
    : null;
  const bill = billIdKey
    ? await prisma.bill.findUnique({
        where: { billId: billIdKey },
        select: {
          billId: true,
          billType: true,
          congressNumber: true,
          currentStatus: true,
          title: true,
          popularTitle: true,
          shortTitle: true,
          displayTitle: true,
          shortText: true,
          aiShortDescription: true,
        },
      })
    : null;

  const fontData = await fontPromise;
  const fonts = fontData
    ? [
        {
          name: "Archivo",
          data: fontData,
          weight: 800 as const,
          style: "normal" as const,
        },
      ]
    : undefined;
  const headers = { "Cache-Control": CACHE_CONTROL };

  if (!bill) {
    return new ImageResponse(<BrandFallback />, { ...size, fonts, headers });
  }

  const { headline: rawHeadline } = pickBillHeadline(bill);
  const headline = clampHeadline(rawHeadline, HEADLINE_HARD_CAP);
  const fontSize = headlineFontSize(headline);
  const identifier = formatBillNumber(bill.billType, bill.billId);
  const citation = bill.congressNumber
    ? `${identifier} · ${formatOrdinal(bill.congressNumber)} Congress`
    : identifier;
  const statusLabel = getStatusExplanation(
    bill.billType,
    bill.currentStatus,
  ).headline;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "72px 80px",
        backgroundColor: SAND,
        fontFamily: "Archivo",
      }}
    >
      {/* Kicker — bill number · congress */}
      <div
        style={{
          display: "flex",
          color: SAPPHIRE_DEEP,
          fontSize: 36,
          letterSpacing: "0.14em",
          fontWeight: 800,
          textTransform: "uppercase",
        }}
      >
        {citation}
      </div>

      {/* Title, sentence case exactly as Congress titles it */}
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          color: INK,
          fontSize,
          lineHeight: 1.06,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          paddingTop: 16,
          paddingBottom: 16,
        }}
      >
        {headline}
      </div>

      {/* Route motif + status on the left, wordmark on the right */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <RouteMotif />
          <div
            style={{
              display: "flex",
              color: INK,
              fontSize: 36,
              fontWeight: 800,
            }}
          >
            {statusLabel}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            color: INK,
            fontSize: 44,
            letterSpacing: "0.02em",
            fontWeight: 800,
          }}
        >
          GOVROLL
        </div>
      </div>
    </div>,
    { ...size, fonts, headers },
  );
}

function BrandFallback() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: SAND,
        fontFamily: "Archivo",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 44 }}>
        <div
          style={{
            display: "flex",
            width: 96,
            height: 96,
            borderRadius: 9999,
            backgroundColor: GOLD,
            border: `17px solid ${SAPPHIRE}`,
          }}
        />
        <div
          style={{
            display: "flex",
            color: INK,
            fontSize: 144,
            fontWeight: 800,
            letterSpacing: "0.02em",
          }}
        >
          GOVROLL
        </div>
      </div>
    </div>
  );
}

import "dotenv/config";
import {
  currentTerm,
  fetchCurrentLegislators,
} from "../lib/congress-legislators";
import { createStandalonePrisma } from "../lib/prisma-standalone";
import { congressGovMemberUrl, nameToSlug } from "../lib/slug";

const prisma = createStandalonePrisma();

/**
 * Normalize a member's district number for storage.
 *
 * The source (congress-legislators, as GovTrack before it) represents
 * at-large seats (single-district states like SD, VT,
 * WY, AK, DE, ND) as `0`, which the old `role.district ? ... : null`
 * check silently coerced to null — leaving us unable to match those reps
 * by district and giving civic-lookup a false "delegate" fingerprint.
 *
 * Returns:
 *   - null for senators and non-representative roles (no district concept)
 *   - "At Large" for the numeric-zero at-large encoding
 *   - the number as a string otherwise (e.g. "14")
 */
export function normalizeDistrict(
  district: number | string | null | undefined,
  chamber: string,
): string | null {
  if (chamber !== "representative") return null;
  if (district == null) return null;
  if (typeof district === "number") {
    if (district === 0) return "At Large";
    return String(district);
  }
  const trimmed = district.trim();
  if (trimmed === "" || trimmed === "0") return "At Large";
  return trimmed;
}

/**
 * Pick a slug for a brand-new representative that won't trip the unique `slug`
 * constraint. Mirrors backfill-rep-slugs.ts: start from the name-based slug,
 * and when a *different* member already holds it (two same-named reps — e.g.
 * the two Rep. Mike Rogers), disambiguate by state, then by bioguideId as a
 * last resort. Slug is create-only — we never re-slug an existing member — so
 * this runs only on the rare new-member path, where the extra lookups are
 * cheap. Without it, the second same-named member's create threw a unique
 * violation that (pre-fix) aborted the entire weekly sweep.
 */
async function resolveSlugForCreate(
  firstName: string,
  lastName: string,
  state: string,
  bioguideId: string,
): Promise<string> {
  const base = nameToSlug(firstName, lastName);
  const candidates = [
    base,
    `${base}-${state.toLowerCase()}`,
    `${base}-${state.toLowerCase()}-${bioguideId.toLowerCase()}`,
  ];
  for (const slug of candidates) {
    const existing = await prisma.representative.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!existing) return slug;
  }
  // Every candidate is taken (vanishingly unlikely). Return the most-specific
  // one anyway; if even that collides, the per-row catch records it.
  return candidates[candidates.length - 1];
}

export async function fetchRepresentativesFunction() {
  try {
    const legislators = await fetchCurrentLegislators();

    // Prefetch the bioguideIds we already store so each member costs a single
    // write (update OR create) instead of a find-then-write pair. With ~540
    // members that halves the DB round trips for the whole sweep — the gap
    // between finishing comfortably and tipping over the function budget into a
    // 504 when the connection pooler is slow (the observed failure mode). We
    // add to the set after each create so a (vanishingly rare) duplicate
    // bioguideId within one batch still resolves to an update, not a unique
    // violation — preserving the old find-per-row behavior.
    const existingRows = await prisma.representative.findMany({
      select: { bioguideId: true },
    });
    const existingBioguideIds = new Set(
      existingRows
        .map((r) => r.bioguideId)
        .filter((id): id is string => Boolean(id)),
    );

    let processed = 0;
    const errors: Array<{ bioguideId: string; error: string }> = [];

    for (const legislator of legislators) {
      const bioguideId = legislator.id?.bioguide;
      const term = currentTerm(legislator);

      if (!bioguideId || !term) {
        console.warn(
          `Skipping legislator without bioguide id or term: ${legislator.name?.first} ${legislator.name?.last}`,
        );
        continue;
      }

      const imageUrl = `https://bioguide.congress.gov/bioguide/photo/${bioguideId[0]}/${bioguideId}.jpg`;
      // Delegates and the resident commissioner are "rep" terms too, and are
      // stored as representatives — same as the GovTrack era.
      const chamber = term.type === "sen" ? "senator" : "representative";
      const district = normalizeDistrict(term.district, chamber);

      // Columns shared by create and update. Slug is intentionally absent —
      // it's set once on create (see resolveSlugForCreate) and never rewritten.
      const fields = {
        firstName: legislator.name.first,
        lastName: legislator.name.last,
        state: term.state,
        district,
        party: term.party,
        chamber,
        imageUrl,
        link: congressGovMemberUrl(
          bioguideId,
          legislator.name.first,
          legislator.name.last,
        ),
        termEnd: term.end ? new Date(term.end) : null,
      };

      // Per-row try/catch: one bad member (e.g. a slug unique-collision
      // between two same-named reps on the create path) must NOT abort the
      // whole weekly roster sweep. Log + count it and continue. A run that
      // fails *every* row throws below, so the cron still alerts loudly.
      try {
        if (existingBioguideIds.has(bioguideId)) {
          await prisma.representative.update({
            where: { bioguideId },
            data: fields,
          });
        } else {
          const slug = await resolveSlugForCreate(
            fields.firstName,
            fields.lastName,
            fields.state,
            bioguideId,
          );
          await prisma.representative.create({
            data: { bioguideId, slug, ...fields },
          });
          // Keep the set authoritative within this run so a repeated
          // bioguideId updates the row we just created instead of colliding.
          existingBioguideIds.add(bioguideId);
        }
        processed++;
      } catch (rowError: unknown) {
        const msg =
          rowError instanceof Error ? rowError.message : String(rowError);
        console.error(`Failed to upsert representative ${bioguideId}:`, msg);
        errors.push({ bioguideId, error: msg });
      }
    }

    console.log(
      `Representatives: ${processed} upserted, ${errors.length} failed (of ${legislators.length} members).`,
    );

    // Had rows but wrote nothing → the run is broken (DB down, schema drift)
    // even though no exception bubbled out of the loop. Surface it so the
    // route returns 500 + alerts rather than a green success that wrote zero.
    if (legislators.length > 0 && processed === 0) {
      throw new Error(
        `fetch-representatives: all ${legislators.length} roster rows failed to upsert`,
      );
    }

    return { processed, errorCount: errors.length };
  } catch (error: unknown) {
    // Systemic failure (roster source unreachable, DB down, or all-rows-failed
    // above). Log and re-throw so the cron route surfaces a 500 + reportError
    // instead of laundering the outage into a green {ok:true}.
    console.error(
      "Error fetching representatives:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  fetchRepresentativesFunction();
}

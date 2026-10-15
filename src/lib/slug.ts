/** Generate a URL-safe slug from a first + last name. */
export function nameToSlug(firstName: string, lastName: string): string {
  return `${firstName}-${lastName}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9-]/g, "-") // non-alphanumeric → hyphen
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, ""); // trim leading/trailing
}

/**
 * A member's Congress.gov profile, e.g.
 * https://www.congress.gov/member/bernard-sanders/S000033 — Congress.gov keys
 * profiles by bioguide id, with a first-last name slug in front. Replaced the
 * GovTrack profile link in Oct 2026, when govtrack.us began putting visitors
 * through a Cloudflare bot check.
 */
export function congressGovMemberUrl(
  bioguideId: string,
  firstName: string,
  lastName: string,
): string {
  return `https://www.congress.gov/member/${nameToSlug(firstName, lastName)}/${bioguideId}`;
}

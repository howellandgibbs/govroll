import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "@/app/api/cron/fetch-representatives/route";
import { server } from "../msw-server";
import { getTestPrisma } from "../db";
import { invokeCron } from "../invoke";

const LEGISLATORS_URL =
  "https://unitedstates.github.io/congress-legislators/legislators-current.json";

/** A legislators-current.json entry (unitedstates/congress-legislators). */
function legislator(o: {
  bioguide: string;
  govtrack?: number;
  first: string;
  last: string;
  type: "rep" | "sen";
  state: string;
  district?: number;
  party: string;
  end?: string;
}) {
  return {
    id: { bioguide: o.bioguide, govtrack: o.govtrack },
    name: { first: o.first, last: o.last },
    terms: [
      {
        type: o.type,
        start: "2025-01-03",
        end: o.end ?? "2027-01-03",
        state: o.state,
        ...(o.district === undefined ? {} : { district: o.district }),
        party: o.party,
      },
    ],
  };
}

describe("GET /api/cron/fetch-representatives", () => {
  it("rejects missing auth", async () => {
    const res = await invokeCron(GET, { auth: null });
    expect(res.status).toBe(401);
  });

  it("returns ok with empty roster", async () => {
    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(await getTestPrisma().representative.count()).toBe(0);
  });

  it("upserts members from the congress-legislators roster", async () => {
    server.use(
      http.get(LEGISLATORS_URL, () =>
        HttpResponse.json([
          legislator({
            bioguide: "P000197",
            govtrack: 400314,
            first: "Nancy",
            last: "Pelosi",
            type: "rep",
            state: "CA",
            district: 11,
            party: "Democrat",
          }),
          legislator({
            bioguide: "S000033",
            govtrack: 400357,
            first: "Bernard",
            last: "Sanders",
            type: "sen",
            state: "VT",
            party: "Independent",
            end: "2031-01-03",
          }),
          legislator({
            bioguide: "N000147",
            first: "Eleanor",
            last: "Norton",
            type: "rep",
            state: "DC",
            district: 0,
            party: "Democrat",
          }),
        ]),
      ),
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);

    const db = getTestPrisma();
    const pelosi = await db.representative.findUnique({
      where: { bioguideId: "P000197" },
    });
    expect(pelosi).toMatchObject({
      lastName: "Pelosi",
      party: "Democrat",
      chamber: "representative",
      state: "CA",
      district: "11",
      link: "https://www.govtrack.us/congress/members/400314",
    });
    expect(pelosi?.termEnd?.toISOString()).toBe("2027-01-03T00:00:00.000Z");

    const sanders = await db.representative.findUnique({
      where: { bioguideId: "S000033" },
    });
    expect(sanders).toMatchObject({
      chamber: "senator",
      party: "Independent",
      district: null,
    });
    expect(sanders?.termEnd?.toISOString()).toBe("2031-01-03T00:00:00.000Z");

    // Delegates are "rep" terms with district 0, stored as at-large
    // representatives (GovTrack-era shape).
    const norton = await db.representative.findUnique({
      where: { bioguideId: "N000147" },
    });
    expect(norton).toMatchObject({
      chamber: "representative",
      district: "At Large",
      link: null,
    });
  });

  it("updates existing members without rewriting slug or link", async () => {
    const db = getTestPrisma();
    await db.representative.create({
      data: {
        bioguideId: "S000033",
        slug: "bernie-sanders",
        firstName: "Bernard",
        lastName: "Sanders",
        state: "VT",
        party: "Democrat",
        chamber: "senator",
        link: "https://www.govtrack.us/congress/members/bernard_sanders/400357",
      },
    });
    server.use(
      http.get(LEGISLATORS_URL, () =>
        HttpResponse.json([
          legislator({
            bioguide: "S000033",
            govtrack: 400357,
            first: "Bernard",
            last: "Sanders",
            type: "sen",
            state: "VT",
            party: "Independent",
          }),
        ]),
      ),
    );

    expect((await invokeCron(GET)).status).toBe(200);
    const row = await db.representative.findUnique({
      where: { bioguideId: "S000033" },
    });
    expect(row).toMatchObject({
      party: "Independent",
      slug: "bernie-sanders",
      link: "https://www.govtrack.us/congress/members/bernard_sanders/400357",
    });
  });

  it("returns 500 when the roster source is down", async () => {
    server.use(
      http.get(LEGISLATORS_URL, () => new HttpResponse(null, { status: 500 })),
    );
    const res = await invokeCron(GET);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("disambiguates slugs for two same-named members instead of aborting the sweep", async () => {
    // There really are two Rep. Mike Rogers (AL-03 and MI-08). On the create
    // path the second one collides on the unique `slug` — pre-fix that threw
    // and (being swallowed) silently aborted the entire weekly roster sweep.
    // Now each upsert is isolated and the slug is disambiguated by state.
    server.use(
      http.get(LEGISLATORS_URL, () =>
        HttpResponse.json([
          legislator({
            bioguide: "R000575",
            first: "Mike",
            last: "Rogers",
            type: "rep",
            state: "AL",
            district: 3,
            party: "Republican",
          }),
          legislator({
            bioguide: "R000585",
            first: "Mike",
            last: "Rogers",
            type: "rep",
            state: "MI",
            district: 8,
            party: "Republican",
          }),
        ]),
      ),
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const reps = await getTestPrisma().representative.findMany({
      orderBy: { bioguideId: "asc" },
    });
    // BOTH members are stored — the collision did not abort the sweep.
    expect(reps).toHaveLength(2);
    const slugs = reps.map((r) => r.slug).sort();
    expect(slugs).toEqual(["mike-rogers", "mike-rogers-mi"]);
    // And the slugs are distinct (the unique constraint is satisfied).
    expect(new Set(slugs).size).toBe(2);
  });
});

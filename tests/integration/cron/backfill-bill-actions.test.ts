import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "@/app/api/cron/backfill-bill-actions/route";
import { server } from "../msw-server";
import { getTestPrisma } from "../db";
import { seedBill } from "../fixtures";
import { invokeCron } from "../invoke";

describe("GET /api/cron/backfill-bill-actions", () => {
  it("rejects missing auth", async () => {
    const res = await invokeCron(GET, { auth: null });
    expect(res.status).toBe(401);
  });

  it("returns ok with nothing to process when no eligible bills exist", async () => {
    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("inserts BillAction rows and stamps lastActionRefreshAt for an eligible live bill", async () => {
    const bill = await seedBill({
      billId: "house_bill-30-119",
      momentumTier: "ACTIVE",
      billType: "house_bill",
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/30/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-03-01",
              text: "Introduced in House",
              type: "IntroReferral",
              sourceSystem: { name: "House floor actions" },
            },
            {
              actionDate: "2026-03-15",
              text: "Referred to Committee",
              type: "Committee",
              sourceSystem: { name: "House committee actions" },
            },
          ],
        }),
      ),
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);

    const actions = await getTestPrisma().billAction.findMany({
      where: { billId: bill.id },
      orderBy: { actionDate: "asc" },
    });
    expect(actions).toHaveLength(2);
    expect(actions[0].text).toBe("Introduced in House");
    expect(actions[1].chamber).toBe("House");

    // lastActionRefreshAt was stamped, so the bill drops out of the
    // pool until the cooldown elapses.
    const refreshed = await getTestPrisma().bill.findUnique({
      where: { id: bill.id },
    });
    expect(refreshed?.lastActionRefreshAt).not.toBeNull();
  });

  it("re-picks a bill once its lastActionRefreshAt is older than the cooldown", async () => {
    // Bill refreshed 12h ago, cooldown is 6h — should re-enter the
    // pool on the next run.
    const stale = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const bill = await seedBill({
      billId: "house_bill-31-119",
      momentumTier: "ACTIVE",
      billType: "house_bill",
      lastActionRefreshAt: stale,
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/31/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-04-01",
              text: "Reported by committee",
              type: "Committee",
              sourceSystem: { name: "House committee actions" },
            },
          ],
        }),
      ),
    );

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.processed).toBe(1);

    const refreshed = await getTestPrisma().bill.findUnique({
      where: { id: bill.id },
    });
    // Stamp moved forward.
    expect(refreshed?.lastActionRefreshAt?.getTime()).toBeGreaterThan(
      stale.getTime(),
    );
  });

  it("skips bills inside the refresh cooldown window", async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago
    await seedBill({
      billId: "house_bill-32-119",
      momentumTier: "ACTIVE",
      billType: "house_bill",
      lastActionRefreshAt: recent,
    });

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("reconciles currentStatus when congress.gov shows a chamber passed but GovTrack still says reported", async () => {
    // The Farm Bill regression. Bill is "reported" in our DB; congress.gov
    // actions show the House passed it on the floor. Cron must lift the
    // status to pass_over_house, advance currentStatusDate, and write the
    // passage as the latestActionText.
    const bill = await seedBill({
      billId: "house_bill-7567-119",
      billType: "house_bill",
      currentStatus: "reported",
      currentStatusDate: new Date("2026-03-05"),
      latestActionDate: new Date("2026-03-05"),
      latestActionText:
        "Ordered to be Reported (Amended) by the Yeas and Nays: 34 - 17.",
      momentumTier: "ACTIVE",
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/7567/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-03-05",
              text: "Ordered to be Reported (Amended) by the Yeas and Nays: 34 - 17.",
              type: "Committee",
              sourceSystem: { name: "House committee actions" },
            },
            {
              actionDate: "2026-04-30",
              text: "On passage Passed by the Yeas and Nays: 224 - 200.",
              type: "Floor",
              sourceSystem: { name: "House floor actions" },
            },
          ],
        }),
      ),
    );

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.statusesReconciled).toBe(1);
    expect(body.latestActionUpdated).toBe(1);

    const after = await getTestPrisma().bill.findUnique({
      where: { id: bill.id },
    });
    expect(after?.currentStatus).toBe("pass_over_house");
    expect(after?.currentStatusDate?.toISOString().slice(0, 10)).toBe(
      "2026-04-30",
    );
    expect(after?.latestActionText).toMatch(/On passage Passed/);
  });

  it("advances latestActionText without changing status when status is already correct", async () => {
    // pass_over_house bill that gets a new procedural action in the
    // Senate. Status stays correct; latestAction must update.
    const bill = await seedBill({
      billId: "house_bill-40-119",
      billType: "house_bill",
      currentStatus: "pass_over_house",
      currentStatusDate: new Date("2026-04-30"),
      latestActionDate: new Date("2026-04-30"),
      latestActionText: "On passage Passed by the Yeas and Nays: 224 - 200.",
      momentumTier: "ACTIVE",
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/40/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-04-30",
              text: "On passage Passed by the Yeas and Nays: 224 - 200.",
              type: "Floor",
              sourceSystem: { name: "House floor actions" },
            },
            {
              actionDate: "2026-05-05",
              text: "Received in the Senate and read twice.",
              type: "Floor",
              sourceSystem: { name: "Senate" },
            },
          ],
        }),
      ),
    );

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.statusesReconciled).toBe(0);
    expect(body.latestActionUpdated).toBe(1);

    const after = await getTestPrisma().bill.findUnique({
      where: { id: bill.id },
    });
    expect(after?.currentStatus).toBe("pass_over_house"); // unchanged
    expect(after?.latestActionText).toMatch(/Received in the Senate/);
  });

  it("stamps lastActionRefreshAt even when congress.gov returns no actions", async () => {
    // A freshly-introduced bill whose actions endpoint returns empty.
    // We still need to mark the refresh so it doesn't permanently
    // monopolize the NULL-first head of the queue.
    const bill = await seedBill({
      billId: "house_bill-50-119",
      billType: "house_bill",
      momentumTier: "ACTIVE",
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/50/actions", () =>
        HttpResponse.json({ actions: [] }),
      ),
    );

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.processed).toBe(1);

    const after = await getTestPrisma().bill.findUnique({
      where: { id: bill.id },
    });
    expect(after?.lastActionRefreshAt).not.toBeNull();
  });

  it("is idempotent on a second run within the cooldown", async () => {
    await seedBill({
      billId: "house_bill-31-119",
      momentumTier: "ACTIVE",
      billType: "house_bill",
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/31/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-03-01",
              text: "Introduced in House",
              type: "IntroReferral",
              sourceSystem: { name: "House" },
            },
          ],
        }),
      ),
    );

    await invokeCron(GET);
    // Second run within the cooldown: the bill we just refreshed must
    // drop out of the pool, and the action upsert must not duplicate.
    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(await getTestPrisma().billAction.count()).toBe(1);
  });

  it("excludes enacted bills from the pool", async () => {
    await seedBill({
      billId: "house_bill-60-119",
      billType: "house_bill",
      currentStatus: "enacted_signed",
      momentumTier: "ENACTED",
    });
    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("priority pass picks bills with vote-after-status mismatch even if mis-tiered", async () => {
    // A DEAD-tier bill (would normally be excluded) where the chamber
    // has clearly passed it — the only reason it's tagged DEAD is the
    // upstream status didn't advance. Priority pass must surface it.
    const prisma = getTestPrisma();
    const mistiered = await seedBill({
      billId: "house_bill-9001-119",
      billType: "house_bill",
      currentStatus: "introduced",
      currentStatusDate: new Date("2026-02-15"),
      momentumTier: "DEAD",
    });
    // Seed a representative + a passage vote DATED AFTER the bill's
    // currentStatusDate — the priority filter looks for exactly this
    // shape.
    const rep = await prisma.representative.create({
      data: {
        bioguideId: "P000001",
        firstName: "Priority",
        lastName: "Rep",
        state: "CA",
        district: "1",
        party: "Democrat",
        chamber: "representative",
        slug: "priority-rep-ca",
      },
    });
    await prisma.representativeVote.create({
      data: {
        billId: mistiered.id,
        representativeId: rep.id,
        vote: "Yea",
        chamber: "House",
        category: "passage",
        rollCallNumber: 42,
        votedAt: new Date("2026-04-30"),
      },
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/9001/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-04-30",
              text: "On passage Passed by the Yeas and Nays: 224 - 200.",
              type: "Floor",
              sourceSystem: { name: "House floor actions" },
            },
          ],
        }),
      ),
    );

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.priorityProcessed).toBe(1);
    expect(body.statusesReconciled).toBe(1);

    const after = await prisma.bill.findUnique({
      where: { id: mistiered.id },
    });
    expect(after?.currentStatus).toBe("pass_over_house");
    expect(after?.lastActionRefreshAt).not.toBeNull();
  });

  it("priority pass ignores bills whose vote dates predate currentStatusDate", async () => {
    // Bill is "reported" on 2026-05-01, vote is from 2026-04-15.
    // Vote is OLDER than the status, so reconcile already happened
    // (or the bill was always at reported); not a staleness signal.
    // Priority filter must not pick this up.
    const prisma = getTestPrisma();
    const bill = await seedBill({
      billId: "house_bill-9002-119",
      billType: "house_bill",
      currentStatus: "reported",
      currentStatusDate: new Date("2026-05-01"),
      momentumTier: "ACTIVE",
    });
    const rep = await prisma.representative.create({
      data: {
        bioguideId: "P000002",
        firstName: "Older",
        lastName: "Rep",
        state: "NY",
        district: "1",
        party: "Republican",
        chamber: "representative",
        slug: "older-rep-ny",
      },
    });
    await prisma.representativeVote.create({
      data: {
        billId: bill.id,
        representativeId: rep.id,
        vote: "Yea",
        chamber: "House",
        category: "passage",
        rollCallNumber: 99,
        votedAt: new Date("2026-04-15"),
      },
    });
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/9002/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-05-01",
              text: "Reported by committee",
              type: "Committee",
              sourceSystem: { name: "House committee actions" },
            },
          ],
        }),
      ),
    );
    const res = await invokeCron(GET);
    const body = await res.json();
    // Routine pass picks it up (tier ACTIVE, never refreshed), but
    // it should not be counted in the priority pass.
    expect(body.priorityProcessed).toBe(0);
    expect(body.processed).toBe(1);
  });

  it("evidence pass reconciles a signed law that was tiered DEAD at 'introduced'", async () => {
    // The Laken Riley Act shape: imported after it was signed, computed
    // DEAD on arrival, never action-refreshed — so neither the routine
    // pool (live tiers) nor the vote-priority pass ever reached it.
    // refresh-bill-metadata had kept latestActionText current, though.
    const prisma = getTestPrisma();
    const law = await seedBill({
      billId: "senate_bill-5-119",
      billType: "senate_bill",
      currentStatus: "introduced",
      currentStatusDate: new Date("2025-01-06"),
      momentumTier: "DEAD",
      latestActionText: "Became Public Law No: 119-1.",
      latestActionDate: new Date("2025-01-29"),
    });
    await prisma.bill.update({
      where: { id: law.id },
      data: { momentumComputedAt: new Date("2026-01-01") },
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/119/s/5/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2025-01-29",
              text: "Became Public Law No: 119-1.",
              type: "BecameLaw",
              sourceSystem: { name: "Library of Congress" },
            },
            {
              actionDate: "2025-01-29",
              text: "Signed by President.",
              type: "President",
              sourceSystem: { name: "Library of Congress" },
            },
          ],
        }),
      ),
    );

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.evidenceProcessed).toBe(1);
    expect(body.statusesReconciled).toBe(1);

    const after = await prisma.bill.findUnique({ where: { id: law.id } });
    expect(after?.currentStatus).toBe("enacted_signed");
    expect(after?.lastActionRefreshAt).not.toBeNull();
    // Queued for compute-momentum so the DEAD tier doesn't linger.
    expect(after?.momentumComputedAt).toBeNull();
  });

  it("evidence pass fetches a bill once, not again until a newer action arrives", async () => {
    // Refreshed after its latest action: the action log has already had
    // its chance to explain the text, so don't spend a call every run.
    await seedBill({
      billId: "house_bill-22-119",
      billType: "house_bill",
      currentStatus: "introduced",
      momentumTier: "DEAD",
      latestActionText: "Received in the Senate.",
      latestActionDate: new Date("2025-04-10"),
      lastActionRefreshAt: new Date("2025-05-01"),
    });
    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.evidenceProcessed).toBe(0);
    expect(body.processed).toBe(0);
  });

  it("passage evidence only counts against bills still introduced or reported", async () => {
    // Already pass_over_house: "Received in the Senate" is consistent.
    await seedBill({
      billId: "house_bill-23-119",
      billType: "house_bill",
      currentStatus: "pass_over_house",
      momentumTier: "DEAD",
      latestActionText: "Received in the Senate.",
      latestActionDate: new Date("2025-04-10"),
    });
    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.evidenceProcessed).toBe(0);
    expect(body.processed).toBe(0);
  });

  it("evidence pass treats the other chamber acting as passage of the bill's own chamber", async () => {
    // H.R. 29 (the House's Laken Riley Act) shape: passed the House, then
    // the Senate's referral became its latest action. "Read twice" has
    // no chamber word, but only the Senate reads a House bill twice.
    const prisma = getTestPrisma();
    const houseBill = await seedBill({
      billId: "house_bill-29-118",
      billType: "house_bill",
      congressNumber: 118,
      currentStatus: "introduced",
      momentumTier: "DEAD",
      latestActionText: "Read twice and referred to the Committee on Finance.",
      latestActionDate: new Date("2024-03-01"),
    });
    const senateBill = await seedBill({
      billId: "senate_bill-31-118",
      billType: "senate_bill",
      congressNumber: 118,
      currentStatus: "introduced",
      momentumTier: "DEAD",
      latestActionText:
        "Referred to the House Committee on Energy and Commerce.",
      latestActionDate: new Date("2024-03-05"),
    });

    server.use(
      http.get("https://api.congress.gov/v3/bill/118/hr/29/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2024-03-01",
              text: "Read twice and referred to the Committee on Finance.",
              type: "IntroReferral",
              sourceSystem: { name: "Senate" },
            },
            {
              actionDate: "2024-02-27",
              text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 251 - 170.",
              type: "Floor",
              sourceSystem: { name: "Library of Congress" },
            },
          ],
        }),
      ),
      http.get("https://api.congress.gov/v3/bill/118/s/31/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2024-03-05",
              text: "Referred to the House Committee on Energy and Commerce.",
              type: "IntroReferral",
              sourceSystem: { name: "House floor actions" },
            },
            {
              actionDate: "2024-03-01",
              text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent.",
              type: "Floor",
              sourceSystem: { name: "Library of Congress" },
            },
          ],
        }),
      ),
    );

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.evidenceProcessed).toBe(2);
    expect(body.statusesReconciled).toBe(2);

    const [h, sb] = await Promise.all([
      prisma.bill.findUnique({ where: { id: houseBill.id } }),
      prisma.bill.findUnique({ where: { id: senateBill.id } }),
    ]);
    expect(h?.currentStatus).toBe("pass_over_house");
    expect(sb?.currentStatus).toBe("pass_over_senate");
  });

  it("evidence pass ignores a Senate bill's own 'read twice' introduction", async () => {
    await seedBill({
      billId: "senate_bill-32-118",
      billType: "senate_bill",
      congressNumber: 118,
      currentStatus: "introduced",
      momentumTier: "DEAD",
      latestActionText: "Read twice and referred to the Committee on Finance.",
      latestActionDate: new Date("2024-03-01"),
    });
    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.evidenceProcessed).toBe(0);
  });

  it("fails loudly (503) on congress.gov quota exhaustion and leaves the bill re-selectable", async () => {
    // A 429 used to be laundered into null actions, the bill got stamped
    // lastActionRefreshAt, and it dropped into a 6h cooldown over a transient
    // throttle. The run must now 503 and NOT stamp the bill.
    const bill = await seedBill({
      billId: "house_bill-42-119",
      billType: "house_bill",
      momentumTier: "ACTIVE",
    });

    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/42/actions",
        () =>
          new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "3600" },
          }),
      ),
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("congress_quota_exhausted");

    const after = await getTestPrisma().bill.findUnique({
      where: { id: bill.id },
    });
    expect(after?.lastActionRefreshAt).toBeNull();
  });
});

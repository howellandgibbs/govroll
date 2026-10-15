import axios from "axios";
import { withRetry } from "./congress-api";

// NOTE: since Oct 2026 govtrack.us sits behind a Cloudflare bot challenge that
// 403s server-side clients. Roll-call votes moved to the chambers' own XML
// (official-votes.ts); /role (fetch-representatives) still depends on this.
const govtrackClient = axios.create({
  baseURL: "https://www.govtrack.us/api/v2",
  timeout: 15_000,
});

export async function fetchGovTrackRoles(params: Record<string, unknown>) {
  const response = await withRetry(() =>
    govtrackClient.get("/role", { params }),
  );
  return response.data.objects;
}

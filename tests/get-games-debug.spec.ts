import { test, expect, type Page } from "@playwright/test";
import ical from "ical-generator";
import fs from "fs";

const organizationId = "F3iSbnnOrSALJPRs"; // static, represents Etobicoke's arena

const schedulesUrl = `https://canlan2-api.sportninja.net/v1/organizations/${organizationId}/schedules?sort=starts_at&direction=desc`;
const seasonDetailsUrl = (seasonId: string) =>
  `https://canlan2-api.sportninja.net/v1/schedules/${seasonId}/children/dropdown`;
const gamesUrl = (scheduleId: string, teamId: string) =>
  `https://canlan2-api.sportninja.net/v1/schedules/${scheduleId}/games?exclude_cancelled_games=1&team_id=${teamId}`;

type AuthHeaders = Record<string, string>;

// Headers the HTTP client sets itself; don't copy these from the site's request
const SKIP_HEADERS = new Set([
  "host", "content-length", "connection", "cookie", "accept-encoding",
  "te", "upgrade-insecure-requests", "priority",
]);

async function sendRequest(page: Page, url: string, headers: AuthHeaders) {
  console.debug(`fetching ${url}`);
  const res = await page.request.get(url, { headers });
  const status = res.status();

  if (status === 401 || status === 403) {
    throw new Error(`${status} ${res.statusText()} from ${url} - the API rejected our auth.`);
  }
  if (!res.ok() && status !== 404) {
    throw new Error(`${status} ${res.statusText()} from ${url}`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text)?.data;
  } catch {
    throw new Error(`Non-JSON response (${status}) from ${url}: ${text.slice(0, 200)}`);
  }
}


test("debug: where is the saturday game", async ({ page }) => {
  await page.goto("https://www.ashl.ca/stats-schedules/");
  const dataResponse = page.waitForResponse(
    (res) => res.url().includes("sportninja.net/v1/") && !res.url().includes("/v1/auth/") &&
      res.request().method() === "GET" && res.ok() && !!res.request().headers()["authorization"],
    { timeout: 30000 });
  await page.getByRole("button", { name: "ASHL" }).click();
  await page.getByRole("button", { name: "Ontario" }).click();
  await page.getByRole("link", { name: "Etobicoke" }).first().click();
  const good = await dataResponse;
  const headers: AuthHeaders = {};
  for (const [name, value] of Object.entries(await good.request().allHeaders()) as [string, string][]) {
    if (!SKIP_HEADERS.has(name) && !name.startsWith(":")) headers[name] = value;
  }
  const teamName = "Milk Men";
  const schedules = await sendRequest(page, schedulesUrl, headers);
  schedules.slice(0, 14).forEach((s: any) =>
    console.log(`DBG season ${s.id} | ${s.name} | ${s.season_type} | ${s.starts_at?.slice(0,10)}..${s.ends_at?.slice(0,10)} | tournament=${s.is_tournament} games=${s.games_count}`));
  const fmt = (g: any) =>
    `${new Date(g.starts_at).toLocaleString("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} | ${g.homeTeam?.name ?? g.homeTeamSlot?.name_full} vs ${g.visitingTeam?.name ?? g.visitingTeamSlot?.name_full} | sched=${g.schedule?.name}(${g.schedule?.id}) type=${g.game_type_id} status=${g.game_status_id} id=${g.id}`;
  for (const s of schedules.filter((s: any) => !(s.name ?? "").includes("Facilities")).slice(0, 3)) {
    console.log(`DBG ===== ${s.name} ${s.id}`);
    let details: any;
    try { details = await sendRequest(page, seasonDetailsUrl(s.id), headers); } catch (e) { console.log("DBG details err", String(e)); continue; }
    if (!details) { console.log("DBG no details"); continue; }
    const teamIds = new Set<string>();
    for (const level of details) {
      for (const sch of level.schedules ?? []) {
        for (const t of sch.teams ?? []) {
          if ((t.name ?? "").toLowerCase().includes("milk")) {
            console.log(`DBG team "${t.name}" ${t.id} in ${level.name} "${sch.name}" ${sch.id}`);
            teamIds.add(t.id);
          }
        }
      }
    }
    for (const teamId of teamIds) {
      for (const variant of [
        `https://canlan2-api.sportninja.net/v1/schedules/${s.id}/games?exclude_cancelled_games=1&team_id=${teamId}`,
        `https://canlan2-api.sportninja.net/v1/schedules/${s.id}/games?team_id=${teamId}`,
        `https://canlan2-api.sportninja.net/v1/teams/${teamId}/games`,
      ]) {
        try {
          const res = await page.request.get(variant, { headers });
          const body = await res.json().catch(() => null);
          const games = body?.data;
          console.log(`DBG ${res.status()} ${variant} -> ${Array.isArray(games) ? games.length : "n/a"} games; pagination=${JSON.stringify(body?.meta?.pagination)}`);
          if (Array.isArray(games)) games.filter((g: any) => g.starts_at >= "2026-10-20").forEach((g: any) => console.log("DBG    " + fmt(g)));
        } catch (e) { console.log("DBG err", variant, String(e)); }
      }
    }
  }
  expect(true).toBe(true);
});

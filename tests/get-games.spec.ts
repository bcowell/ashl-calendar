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

async function getGames(page: Page, headers: AuthHeaders, teamName: string, dayOfWeek: string) {
  let games: Array<any> = [];

  // The schedule just contains a list of each season
  const schedules = await sendRequest(page, schedulesUrl, headers);
  if (!Array.isArray(schedules)) {
    throw new Error(`Unexpected schedules response: ${JSON.stringify(schedules)?.slice(0, 200)}`);
  }

  // Grab the most recent 5 seasons (excluding facilities), and loop through oldest -> newest.
  // Iterate the season objects (not names) - several seasons share the same name.
  const seasons = schedules
    .filter((s: any) => s?.id && !(s.name ?? "").includes("Facilities"))
    .slice(0, 5)
    .reverse();

  for (const season of seasons) {
    const seasonId: string = season.id;
    const seasonName: string = season.name;
    // One bad season (new/hidden/private schedule, API hiccup) shouldn't sink the whole calendar
    try {
      // dropdown contains current season, conference and team division info. Including team id
      const seasonDetails = await sendRequest(page, seasonDetailsUrl(seasonId), headers);

      if (!seasonDetails) {
        console.debug(
          "Season details not found. It's possible you're looking at a future season - skipping."
        );
        continue;
      }

      const divisions = seasonDetails.find((item: any) => item.name === "Division");
      if (!divisions?.schedules?.length) {
        console.error(`No division schedules found for ${seasonName} - skipping.`);
        continue;
      }

      let teamId: string | undefined;
      let divisionId: string | undefined;
      let divisionName: string | undefined;

      // If your team, like ours, bounces around divisions. Find team across all divisions
      divisions.schedules.forEach((division: any) => {
        division.teams?.forEach((team: any) => {
          if (team.name === teamName) {
            teamId = team.id;
            divisionId = division.id;
            divisionName = division.name;
          }
        });
      });

      // Might be looking at a future season, or our team is not found in division schedules
      if (!teamId || !divisionId || !divisionName) {
        console.error(
          `Team "${teamName}" not found in division schedules for ${seasonName}.`
        );
        continue;
      }

      // Division names are spelled inconsistently ("Men's" vs "Mens")
      if (!divisionName.toLowerCase().startsWith(dayOfWeek.toLowerCase())) {
        console.debug(
          `${seasonName}: team plays in "${divisionName}", not ${dayOfWeek} - skipping.`
        );
        continue;
      }

      console.debug(`${seasonName}: found "${teamName}" in "${divisionName}".`);

      const gamesForSeason = await sendRequest(page, gamesUrl(divisionId, teamId), headers);

      if (!Array.isArray(gamesForSeason)) {
        console.error(`Unexpected response for games in ${seasonName} - skipping.`);
        continue;
      }
      games = [...games, ...gamesForSeason.map((g: any) => ({ ...g, season_id: seasonId }))];
    } catch (err) {
      console.error(`Failed to load ${seasonName} - skipping:`, err);
    }
  }

  return games;
}

test("grab auth token and fetch games through api", async ({ page }) => {
  const calendarName = process.env.CALENDAR_NAME || "ASHL Milk Men";
  const iCalFileName = process.env.ICAL_FILE_NAME || "V1.0.0";
  const scheduleBaseUrl =
    process.env.SCHEDULE_BASE_URL || "https://www.ashl.ca/stats-schedules/";
  const teamName = process.env.TEAM_NAME || "Milk Men";
  const dayOfWeek = process.env.DAY_OF_WEEK || "Monday";

  await page.goto(scheduleBaseUrl);

  // The schedule widget refreshes its API token on load (POST /v1/auth/refresh), then uses the
  // new token for its data calls. Copy the headers from one of those successful GETs.
  const dataResponse = page
    .waitForResponse(
      (res) =>
        res.url().includes("sportninja.net/v1/") &&
        !res.url().includes("/v1/auth/") &&
        res.request().method() === "GET" &&
        res.ok() &&
        !!res.request().headers()["authorization"],
      { timeout: 30000 }
    )
    .catch(() => null);

  // ASHL > Ontario > Etobicoke -> redirects to current (or next season when in playoffs)
  await page.getByRole("button", { name: "ASHL" }).click();
  await page.getByRole("button", { name: "Ontario" }).click();
  await page.getByRole("link", { name: "Etobicoke" }).first().click();

  const good = await dataResponse;
  if (!good) {
    throw new Error("Never saw the schedule widget make an authenticated API call - the site has changed.");
  }

  const headers: AuthHeaders = {};
  for (const [name, value] of Object.entries(await good.request().allHeaders()) as [string, string][]) {
    if (!SKIP_HEADERS.has(name) && !name.startsWith(":")) headers[name] = value;
  }

  const currentUrl = page.url();
  const scheduleBaseUrlResolved = currentUrl.split("#")[0];

  const games = await getGames(page, headers, teamName, dayOfWeek);

  // Fail before touching the .ics so a bad run never wipes the published calendar
  expect(games.length, "No games found in any recent season - check the logs above").toBeGreaterThan(0);

  const calendar = ical({ name: calendarName });

  let skipped = 0;
  games.forEach((game) => {
    // Newly published games can be missing venue/address/schedule/team info (TBD rink,
    // playoff placeholders, etc). Never let one incomplete game break the whole calendar.
    if (!game?.id || !game?.starts_at) {
      console.warn(`Skipping game with no id/start time: ${JSON.stringify(game)?.slice(0, 200)}`);
      skipped++;
      return;
    }

    try {
      const startTime = new Date(game.starts_at);
      const endTime = new Date(game.starts_at);
      endTime.setHours(endTime.getHours() + 1);

      const homeTeam = game.homeTeam?.name || game.homeTeamSlot?.name_full || "TBD";
      const visitingTeam =
        game.visitingTeam?.name || game.visitingTeamSlot?.name_full || "TBD";
      const venue = game.venue?.name;
      const facility = game.facility?.name || "";
      const address = game.venue?.address;
      const location = [
        venue,
        address?.street_1,
        address?.city,
        address?.province?.iso_3166_2,
        address?.postal_code,
      ]
        .filter(Boolean)
        .join(", ");
      const schedule = game.schedule?.name || "";
      const isPlayoffGame = game.game_type_id !== 2; // 2 = REGULAR_SEASON
      const playoffBracketUrl = `${scheduleBaseUrlResolved}#/schedule/${game.season_id}?schedule_id=${game.schedule?.id ?? ""}`;

      calendar.createEvent({
        id: game.id,
        start: startTime,
        end: endTime,
        summary: `${homeTeam} vs ${visitingTeam}`,
        location: location || undefined,
        description: [
          facility,
          schedule,
          `Home: ${homeTeam}`,
          `Away: ${visitingTeam}`,
          isPlayoffGame ? `Playoff bracket: ${playoffBracketUrl}` : null,
        ].filter(Boolean).join("\n"),
      });
    } catch (err) {
      console.error(`Skipping game ${game.id} (${game.starts_at}):`, err);
      skipped++;
    }
  });

  console.log(`Wrote ${games.length - skipped} events (${skipped} skipped).`);

  fs.writeFileSync(`./ics/${iCalFileName}.ics`, calendar.toString());

  expect(games).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        starts_at: expect.any(String),
      }),
    ])
  );
});

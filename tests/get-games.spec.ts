import { test, expect, type Page, type Frame } from "@playwright/test";
import ical from "ical-generator";
import fs from "fs";

const organizationId = "F3iSbnnOrSALJPRs"; // static, represents Etobicoke's arena

const schedulesUrl = `https://canlan2-api.sportninja.net/v1/organizations/${organizationId}/schedules?sort=starts_at&direction=desc`;
const seasonDetailsUrl = (seasonId: string) =>
  `https://canlan2-api.sportninja.net/v1/schedules/${seasonId}/children/dropdown`;
const gamesUrl = (scheduleId: string, teamId: string) =>
  `https://canlan2-api.sportninja.net/v1/schedules/${scheduleId}/games?exclude_cancelled_games=1&team_id=${teamId}`;

type AuthHeaders = Record<string, string>;
type RawResponse = { status: number; statusText: string; text: string };
type Fetcher = (url: string) => Promise<RawResponse>;

// Headers we must not replay by hand; the browser/HTTP client sets these itself
const SKIP_HEADERS = new Set([
  "host", "content-length", "connection", "cookie", "accept-encoding",
  "te", "upgrade-insecure-requests", "priority",
]);

// Three ways of calling the API, from least to most "inside the browser".
// We try each against the first endpoint and keep whichever one the API accepts.
function buildFetchers(page: Page, frame: Frame | null, headers: AuthHeaders) {
  const fetchers: Array<[string, Fetcher]> = [
    [
      "browser context (shares the page's cookies)",
      async (url) => {
        const res = await page.request.get(url, { headers });
        return { status: res.status(), statusText: res.statusText(), text: await res.text() };
      },
    ],
  ];
  if (frame) {
    fetchers.push([
      "in-page fetch (same frame as the site's own calls)",
      (url) =>
        frame.evaluate(
          async ({ url, headers }) => {
            // Only send headers a page script is allowed to set, or CORS blocks the request
            const safe: Record<string, string> = {};
            for (const k of ["authorization", "accept", "content-type"]) if (headers[k]) safe[k] = headers[k];
            const res = await fetch(url, { headers: safe, credentials: "include" });
            return { status: res.status, statusText: res.statusText, text: await res.text() };
          },
          { url, headers }
        ),
    ]);
  }
  fetchers.push([
    "node fetch (original approach)",
    async (url) => {
      const res = await fetch(url, { headers });
      return { status: res.status, statusText: res.statusText, text: await res.text() };
    },
  ]);
  return fetchers;
}

async function pickFetcher(fetchers: Array<[string, Fetcher]>, probeUrl: string) {
  const attempts: string[] = [];
  for (const [name, fetcher] of fetchers) {
    try {
      const res = await fetcher(probeUrl);
      attempts.push(`${name}: ${res.status}`);
      if (res.status >= 200 && res.status < 300) {
        console.log(`API auth OK via ${name}`);
        return fetcher;
      }
    } catch (err) {
      attempts.push(`${name}: threw ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`Every way of calling the API was rejected:\n  ${attempts.join("\n  ")}`);
}

async function sendRequest(url: string, fetcher: Fetcher) {
  console.debug(`fetching ${url}`);
  const res = await fetcher(url);

  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} ${res.statusText} from ${url} - the API rejected our auth.`);
  }

  if ((res.status < 200 || res.status >= 300) && res.status !== 404) {
    throw new Error(`${res.status} ${res.statusText} from ${url}`);
  }

  try {
    return JSON.parse(res.text)?.data;
  } catch {
    throw new Error(
      `Non-JSON response (${res.status}) from ${url}: ${res.text.slice(0, 200)}`
    );
  }
}

async function getGames(fetcher: Fetcher, teamName: string, dayOfWeek: string) {
  let games: Array<any> = [];

  // The schedule just contains a list of each season
  const schedules = await sendRequest(schedulesUrl, fetcher);
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
      const seasonDetails = await sendRequest(seasonDetailsUrl(seasonId), fetcher);

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

      const gamesForSeason = await sendRequest(gamesUrl(divisionId, teamId), fetcher);

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

  // The schedule widget calls the stats API itself. Rather than guessing how it authenticates,
  // record its API traffic and copy a request the API actually accepted.
  // Log the path of each API call the site makes (query values redacted, just in case)
  const shortUrl = (u: string) => {
    const url = new URL(u);
    const params = [...url.searchParams.keys()].join("&");
    return `${url.pathname}${params ? `?${params}` : ""}`;
  };
  const siteCalls: string[] = [];
  page.on("response", (res) => {
    if (res.url().includes("sportninja.net/")) {
      siteCalls.push(`${res.status()} ${res.request().method()} ${shortUrl(res.url())}`);
    }
  });
  const okResponse = page
    .waitForResponse(
      (res) =>
        res.url().includes("sportninja.net/v1/") &&
        res.ok() && res.request().method() === "GET" && !res.url().includes("/v1/auth/") &&
        !!res.request().headers()["authorization"],
      { timeout: 30000 }
    )
    .catch(() => null);

  // ASHL > Ontario > Etobicoke -> redirects to current (or next season when in playoffs)
  await page.getByRole("button", { name: "ASHL" }).click();
  await page.getByRole("button", { name: "Ontario" }).click();
  await page.getByRole("link", { name: "Etobicoke" }).first().click();

  const good = await okResponse;
  // Give the widget a moment to finish any token refresh before we copy its headers
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log(`Site's own API calls:\n  ${siteCalls.join("\n  ") || "none"}`);

  const headers: AuthHeaders = {};
  let frame: Frame | null = null;
  if (good) {
    frame = good.frame();
    const all = await good.request().allHeaders();
    for (const [name, value] of Object.entries(all) as [string, string][]) {
      if (!SKIP_HEADERS.has(name) && !name.startsWith(":")) headers[name] = value;
    }
  } else {
    console.warn("Never saw a successful authenticated API call from the site - falling back to localStorage token.");
    const token = await page
      .waitForFunction(() => localStorage.getItem("session_token_iframe"), null, { timeout: 10000 })
      .then((h) => h.jsonValue() as Promise<string | null>)
      .catch(() => null);
    if (token) headers["authorization"] = `Bearer ${token}`;
  }

  if (!headers["authorization"]) {
    throw new Error("Could not find an auth token - the site's login flow has changed.");
  }
  // Log header names only; never print the token itself (Actions logs are visible to others)
  console.log(`Replaying headers: ${Object.keys(headers).join(", ")}`);

  // Diagnostic: does replaying the site's OWN successful call work? If yes, our auth is fine
  // and it's our endpoint that's now off-limits. If no, the token can't be reused at all.
  if (good) {
    const replay = await page.request
      .get(good.url(), { headers })
      .then((r) => String(r.status()))
      .catch((e) => `threw ${(e as Error).message.split("\n")[0]}`);
    console.log(`Replay of site's own call ${shortUrl(good.url())} -> ${replay}`);
  }

  const fetcher = await pickFetcher(buildFetchers(page, frame, headers), schedulesUrl);

  const currentUrl = page.url();
  const scheduleBaseUrlResolved = currentUrl.split("#")[0];

  const games = await getGames(fetcher, teamName, dayOfWeek);

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

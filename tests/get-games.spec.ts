import { test, expect } from "@playwright/test";
import ical from "ical-generator";
import fs from "fs";

const organizationId = "F3iSbnnOrSALJPRs"; // static, represents Etobicoke's arena

const schedulesUrl = `https://canlan2-api.sportninja.net/v1/organizations/${organizationId}/schedules?sort=starts_at&direction=desc`;
const seasonDetailsUrl = (seasonId: string) =>
  `https://canlan2-api.sportninja.net/v1/schedules/${seasonId}/children/dropdown`;
const gamesUrl = (conferenceId: string, teamId: string) =>
  `https://canlan2-api.sportninja.net/v1/schedules/${conferenceId}/games?exclude_cancelled_games=1&team_id=${teamId}&default=1`;

async function sendRequest(url: string, token: string) {
  console.debug(`fetching ${url}`);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json();
  return body?.data;
}

async function getGames(token: string, teamName: string, dayOfWeek: string) {
  let games: Array<any> = [];

  // The schedule just contains a list of each season
  const schedules = await sendRequest(schedulesUrl, token);

  // Grab the most recent 5 seasons (excluding facilities), and loop through oldest -> newest.
  const seasonNames = schedules.filter((s: any) => !s.name.includes("Facilities")).map((s: any) => s.name).slice(0, 5).reverse();

  for (const seasonName of seasonNames) {
    // dropdown contains current season, conference and team division info. Including team id
    const seasonId = schedules.find((item: any) => item.name === seasonName)?.id;
    const seasonDetails = await sendRequest(seasonDetailsUrl(seasonId), token);

    if (!seasonDetails) {
      console.debug(
        "Season details not found. It's possible you're looking at a future season - skipping."
      );
      continue;
    }

    const conferenceId = seasonDetails
      .find((item: any) => item.name === "Conference")
      ?.schedules.find((s: any) => s.name === dayOfWeek)?.id;

    let teamId: string | undefined;

    // If your team, like ours, bounces around divisions. Find team across all divisions
    seasonDetails
      .find((item: any) => item.name === "Division")
      ?.schedules.forEach((division: any) => {
        division.teams?.forEach((team: any) => {
          if (team.name === teamName) {
            teamId = team.id;
          }
        });
      });

    // Might be looking at a future season, or our team is not found in division schedules
    if (!teamId) {
      console.error(
        `Team "${teamName}" not found in division schedules for ${seasonName}.`
      );
      continue;
    }

    const gamesForSeason = await sendRequest(gamesUrl(conferenceId, teamId), token);
    // console.debug(gamesForSeason);
    games = [...games, ...gamesForSeason.map((g: any) => ({ ...g, season_id: seasonId }))];
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

  // ASHL > Ontario > Etobicoke -> redirects to current (or next season when in playoffs)
  await page.getByRole("button", { name: "ASHL" }).click();
  await page.getByRole("button", { name: "Ontario" }).click();
  await page.getByRole("link", { name: "Etobicoke" }).click();

  // Wait for session_token_iframe to be set in localStorage
  await page.waitForTimeout(3000);

  const token = await page.evaluate(() =>
    localStorage.getItem("session_token_iframe")
  );

  const currentUrl = page.url();
  const scheduleBaseUrlResolved = currentUrl.split("#")[0];

  const games = await getGames(token!, teamName, dayOfWeek);

  const calendar = ical({ name: calendarName });

  games.forEach((game) => {
    // console.debug(game);

    const gameId = game.id;
    const startTime = new Date(game.starts_at);
    let endTime = new Date(game.starts_at);
    endTime.setHours(endTime.getHours() + 1);

    const homeTeam = game.homeTeam?.name || game.homeTeamSlot?.name_full;
    const visitingTeam =
      game.visitingTeam?.name || game.visitingTeamSlot?.name_full;
    const venue = game.venue.name;
    const facility = game.facility?.name || "";
    const streetAddress = game.venue.address.street_1;
    const city = game.venue.address.city;
    const province = game.venue.address.province.iso_3166_2;
    const postalCode = game.venue.address.postal_code;
    const schedule = game.schedule.name;
    const isPlayoffGame = game.game_type_id !== 2; // 2 = REGULAR_SEASON
    const playoffBracketUrl = `${scheduleBaseUrlResolved}#/schedule/${game.season_id}?schedule_id=${game.schedule.id}`;

    calendar.createEvent({
      id: gameId,
      start: startTime,
      end: endTime,
      summary: `${homeTeam} vs ${visitingTeam}`,
      location: `${venue}, ${streetAddress}, ${city}, ${province}, ${postalCode}`,
      description: [
        facility,
        schedule,
        `Home: ${homeTeam}`,
        `Away: ${visitingTeam}`,
        isPlayoffGame ? `Playoff bracket: ${playoffBracketUrl}` : null,
      ].filter(Boolean).join("\n"),
    });
  });

  fs.writeFile(`./ics/${iCalFileName}.ics`, calendar.toString(), (err) => {
    if (err) throw err;
  });

  expect(games).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        starts_at: expect.any(String),
      }),
    ])
  );
});

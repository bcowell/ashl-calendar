import { test, expect } from "@playwright/test";
import ical from "ical-generator";
import fs from "fs";

test("grab auth token and fetch games through api", async ({ page }) => {
  const calendarName = process.env.CALENDAR_NAME || "ASHL Big City Boys";
  const iCalFileName = process.env.ICAL_FILE_NAME || "V1.0.0";
  const scheduleBaseUrl =
    process.env.SCHEDULE_BASE_URL || "https://www.ashl.ca/stats-schedules/";

  const teamName = process.env.TEAM_NAME || "Big City Boys";
  const dayOfWeek = process.env.DAY_OF_WEEK || "Monday";

  await page.goto(scheduleBaseUrl);

  // // uncomment to display all logs
  // page.on("console", (msg) => {
  //   console.log(msg);
  // });

  // page.on("console", (message) => {
  //   if (message.type() === "info") {
  //     console.log(message);
  //   }
  // });

  // ASHL > Ontario > Etobicoke -> redirects to current (or next season when in playoffs)
  await page.getByRole("button", { name: "ASHL" }).click();
  await page.getByRole("button", { name: "Ontario" }).click();
  await page.getByRole("link", { name: "CWENCH Centre - Etobicoke" }).click();

  // Wait for session_token_iframe to be set in localStorage
  await page.waitForTimeout(3000);

  const games = await page.evaluate(
    async ([teamName, dayOfWeek]) => {
      // TODO: can pull this by listening the the page's request to /v1/organizations...
      const organizationId = "F3iSbnnOrSALJPRs"; // seems to be static, represents Etobicoke's arena
      const seasonNames = [
        "2024 Summer",
        "2024 Summer Playoffs",
        "2024/25 Winter",
        "2024/25 Winter Playoffs",
        "2025 Summer",
        "2025 Summer Playoffs",
      ];

      const schedulesUrl = `https://canlan2-api.sportninja.net/v1/organizations/${organizationId}/schedules?sort=starts_at&direction=desc`;
      const seasonDetailsUrl = (seasonId) =>
        `https://canlan2-api.sportninja.net/v1/schedules/${seasonId}/children/dropdown`;
      const gamesUrl = (conferenceId, teamId) =>
        `https://canlan2-api.sportninja.net/v1/schedules/${conferenceId}/games?exclude_cancelled_games=1&team_id=${teamId}&default=1`;

      async function sendRequest(url) {
        try {
          const bearerToken = localStorage.getItem("session_token_iframe");

          console.debug(`fetching ${url}`);

          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
              "Content-Type": "application/json",
            },
          });

          const responseBody = await res.json();

          // Error gives { status, message }, otherwise we have { data }
          return responseBody?.data;
        } catch (err) {
          console.error(err);
        }
      }

      async function getGames() {
        let games: Array<any> = [];

        // The schedule just contains a list of each season
        const schedules = await sendRequest(schedulesUrl);

        for (let seasonName of seasonNames) {
          const seasonId = schedules.find(
            (item) => item.name === seasonName
          )?.id;

          // dropdown contains current season, conference and team division info. Including team id
          const currentSeasonDetailsUrl = seasonDetailsUrl(seasonId);
          const seasonDetails = await sendRequest(currentSeasonDetailsUrl);

          if (!seasonDetails) {
            console.debug(
              "Season details not found. It's possible you're looking at a future season - skipping."
            );
            continue;
          }

          const conferenceId = seasonDetails
            .find((item) => item.name === "Conference")
            ?.schedules.find((s) => s.name === dayOfWeek)?.id;
          let teamId;

          // If your team, like ours, bounces around divisions. Find team across all divisions
          seasonDetails
            .find((item) => item.name === "Division")
            ?.schedules.forEach((division) => {
              division.teams?.forEach((team) => {
                if (team.name === teamName) {
                  teamId = team.id;
                }
              });
            });

          const ourGamesUrl = gamesUrl(conferenceId, teamId);
          const gamesForSeason = await sendRequest(ourGamesUrl);
          games = [...games, ...gamesForSeason];
        }

        return games;
      }

      return await getGames();
    },
    [teamName, dayOfWeek]
  );

  const calendar = ical({ name: calendarName });

  games.forEach((game) => {
    console.debug(game);
    const gameId = game.id;
    const startTime = new Date(game.starts_at);
    let endTime = new Date(game.starts_at);
    endTime.setHours(endTime.getHours() + 1);

    const homeTeam = game.homeTeam?.name || game.homeTeamSlot?.name_full;
    const visitingTeam =
      game.visitingTeam?.name || game.visitingTeamSlot?.name_full;
    const venue = game.venue.name;
    const facility = game.facility.name;
    const streetAddress = game.venue.address.street_1;
    const city = game.venue.address.city;
    const province = game.venue.address.province.iso_3166_2;
    const postalCode = game.venue.address.postal_code;
    const schedule = game.schedule.name;

    calendar.createEvent({
      id: gameId,
      start: startTime,
      end: endTime,
      summary: `${homeTeam} vs ${visitingTeam}`,
      location: `${venue}, ${streetAddress}, ${city}, ${province}, ${postalCode}`,
      description: `${facility}
${schedule}
Home: ${homeTeam}
Away: ${visitingTeam}`,
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

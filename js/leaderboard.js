import {createPublicClient, isConfigured, configurationMessage} from "./supabase.js";
import {formatScore,rankTeams} from "./scoring.js";
import {loadTeamConfig, publicTeamName} from "./team-config.js";
const outlet = document.querySelector("#leaderboard-content");
const updated = document.querySelector("#updated-at");
const indicator = document.querySelector(".refresh-indicator");
let hasRendered = false;
function setConnection(connected) {
  updated.textContent = connected ? "Connected" : "Not connected";
  indicator.classList.toggle("is-connected", connected);
}
function state(message, error = false) { outlet.innerHTML = `<div class="state-card ${error ? "error-state" : ""}">${error ? `<strong>Leaderboard unavailable</strong>${message}<br><button class="button button-secondary button-small" id="retry-load" style="margin-top:14px">Try again</button>` : message}</div>`; document.querySelector("#retry-load")?.addEventListener("click", load); }
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
async function load() {
  if (!isConfigured()) { state(configurationMessage(), true); return; }
  if (!hasRendered) outlet.innerHTML = '<div class="state-card loading-card"><span class="spinner" aria-hidden="true"></span><span>Loading the leaderboard…</span></div>';
  try {
    const config = await loadTeamConfig();
    const {data,error} = await createPublicClient().from("public_leaderboard").select("team_name,overall_score");
    if (error) throw error;
    setConnection(true);
    if (!data?.length || data.every(team => team.overall_score === null)) { state('<div class="empty-state"><strong>No scores yet.</strong></div>'); hasRendered=true; return; }
    const namedTeams = data.map(team => ({...team, team_name: publicTeamName(config, team.team_name) || `Unmapped team (${team.team_name})`}));
    const rows = rankTeams(namedTeams).map(team => {const rank=team.rank,score=Number(team.overall_score||0);return `<div class="leaderboard-row"><div class="rank rank-${rank}">${rank}</div><div class="team-name">${escapeHTML(team.team_name)}</div><div class="team-score">${formatScore(score)}<span class="score-unit">PTS</span></div></div>`;}).join("");
    outlet.innerHTML = `<div class="leaderboard-card"><div class="leaderboard-head"><span>Rank</span><span>Team</span><span>Overall score</span></div>${rows}</div>`;
    hasRendered=true;
  } catch (error) { state("The leaderboard could not be loaded. Confirm the Supabase project URL and key are correct and that supabase/schema.sql has been run.", true); hasRendered=true; setConnection(false); console.error(error); }
}
load();
setInterval(load, 30000);

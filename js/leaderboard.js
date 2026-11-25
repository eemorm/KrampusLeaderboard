import {createPublicClient, isConfigured, configurationMessage} from "./supabase.js";
import {formatScore,rankTeams} from "./scoring.js";
import {loadTeamConfig, publicTeamName} from "./team-config.js";
const outlet = document.querySelector("#leaderboard-content");
const updated = document.querySelector("#updated-at");
let hasRendered = false;
function state(message, error = false) { outlet.innerHTML = `<div class="state-card ${error ? "error-state" : ""}">${error ? `<strong>Standings unavailable</strong>${message}<br><button class="button button-secondary button-small" id="retry-load" style="margin-top:14px">Try again</button>` : message}</div>`; document.querySelector("#retry-load")?.addEventListener("click", load); }
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
async function load() {
  updated.textContent = "Connecting to scores…";
  if (!isConfigured()) { state(configurationMessage(), true); updated.textContent = "Not connected"; return; }
  if (!hasRendered) outlet.innerHTML = '<div class="state-card loading-card"><span class="spinner" aria-hidden="true"></span><span>Loading the standings…</span></div>';
  try {
    const config = await loadTeamConfig();
    const {data,error} = await createPublicClient().from("public_leaderboard").select("team_name,overall_score");
    if (error) throw error;
    if (!data?.length || data.every(team => team.overall_score === null)) { state('<div class="empty-state"><strong>Scores are on their way.</strong><p>Once teams start submitting, the standings will appear here.</p></div>'); hasRendered=true; updated.textContent="No submissions yet"; return; }
    const namedTeams = data.map(team => ({...team, team_name: publicTeamName(config, team.team_name) || `Unmapped team (${team.team_name})`}));
    const rows = rankTeams(namedTeams).map(team => {const rank=team.rank,score=Number(team.overall_score||0);return `<div class="leaderboard-row"><div class="rank rank-${rank}">${rank}</div><div class="team-name">${escapeHTML(team.team_name)}</div><div class="team-score">${formatScore(score)}<span class="score-unit">PTS</span></div></div>`;}).join("");
    outlet.innerHTML = `<div class="leaderboard-card"><div class="leaderboard-head"><span>Rank</span><span>Team</span><span>Overall score</span></div>${rows}</div>`;
    hasRendered=true;
    updated.textContent = `Updated ${new Intl.DateTimeFormat("en-US",{hour:"numeric",minute:"2-digit"}).format(new Date())}`;
  } catch (error) { state("The standings could not be loaded. Confirm the Supabase project URL and key are correct and that supabase/schema.sql has been run.", true); hasRendered=true; updated.textContent="Connection issue"; console.error(error); }
}
load();
setInterval(load, 30000);

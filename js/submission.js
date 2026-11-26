import {isConfigured, configurationMessage, login, createPrivateClient} from "./supabase.js";
import {competitionPoints, formatScore, summarizeTeam} from "./scoring.js";
import {readToken, storeToken, clearToken, escapeHTML, scoreOptions} from "./authentication.js";
import {loadTeamConfig, getTeamById, mapMembers} from "./team-config.js";

const loginPanel = document.querySelector("#login-panel");
const dashboard = document.querySelector("#team-dashboard");
const form = document.querySelector("#team-login-form");
const errorBox = document.querySelector("#login-error");
let auth = readToken("team");
const existingAdminAuth = readToken("admin");
let client = null;
let team = null;

function showError(message) { errorBox.textContent = message; }
function notice(message, type = "success") {
  const box = dashboard.querySelector(".dashboard-notice");
  if (box) {
    box.textContent = message;
    box.className = `dashboard-notice ${type}`;
    box.classList.remove("hidden");
  }
}
function hideLogin() {
  loginPanel.classList.add("hidden");
  dashboard.classList.remove("hidden");
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  showError("");
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    if (!isConfigured()) throw new Error(configurationMessage());
    const pin = new FormData(form).get("pin");
    try {
      auth = await login(pin, "team");
      clearToken("admin");
      storeToken("team", auth);
      await start();
    } catch (teamError) {
      if (teamError.status !== 401) throw teamError;
      const adminAuth = await login(pin, "admin");
      clearToken("team");
      storeToken("admin", adminAuth);
      window.location.replace("admin.html");
    }
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Continue";
  }
});

async function start() {
  if (!auth) return;
  client = createPrivateClient(auth.token);
  hideLogin();
  dashboard.innerHTML = '<div class="state-card"><span class="spinner" aria-hidden="true"></span>Loading your team dashboard…</div>';
  try {
    await loadDashboard();
  } catch (error) {
    dashboard.innerHTML = `<div class="state-card error-state"><strong>We couldn’t load your dashboard.</strong>${escapeHTML(error.message)}<br><button class="button button-secondary button-small" id="sign-out" style="margin-top:14px">Sign in again</button></div>`;
    dashboard.querySelector("#sign-out").onclick = signOut;
  }
}

function signOut() {
  clearToken("team");
  auth = null;
  client = null;
  dashboard.classList.add("hidden");
  loginPanel.classList.remove("hidden");
  document.querySelector("#team-pin").value = "";
}

async function loadDashboard() {
  const [identity, dashboardResult, config] = await Promise.all([
    client.from("teams").select("id").single(),
    client.rpc("team_dashboard"),
    loadTeamConfig()
  ]);
  if (identity.error) throw identity.error;
  const {data, error} = dashboardResult;
  if (error) throw error;
  const configuredTeam = getTeamById(config, identity.data.id);
  const mapping = mapMembers(configuredTeam, data.members || []);
  team = {
    ...data,
    team_name: configuredTeam?.name || `Unmapped team (${identity.data.id})`,
    members: mapping.members,
    member_mapping_complete: mapping.complete
  };
  render();
}

function renderEssayRow(essayNumber, members) {
  const essays = members.map(member => member.essays.find(item => item.essay_number === essayNumber));
  const lockedCount = essays.filter(essay => essay.is_locked).length;
  const locked = lockedCount === essays.length;
  const pendingAdminCorrection = essays.some(essay => !essay.is_locked && essay.raw_score !== null);
  const status = locked ? "Submitted & locked" : lockedCount ? `Partially locked · ${lockedCount}/${essays.length}` : pendingAdminCorrection ? "Awaiting admin" : "Not submitted";
  const statusClass = locked ? "locked" : "";
  const scores = essays.map((essay, index) => {
    const correction = !essay.is_locked && essay.raw_score !== null;
    const disabled = essay.is_locked || correction;
    return `<td><div class="grid-score-cell"><select class="raw-score" data-member-number="${members[index].member_number}" aria-label="${escapeHTML(members[index].display_name)} essay ${essayNumber} score" ${disabled ? "disabled" : ""}>${scoreOptions(essay.raw_score)}</select><span class="points-output">${essay.competition_points === null ? "—" : `${essay.competition_points} pts`}</span></div></td>`;
  }).join("");
  const action = locked
    ? '<span class="status-pill locked">Locked</span>'
    : pendingAdminCorrection
      ? '<span class="status-pill">Awaiting admin</span>'
      : `<button class="button button-primary button-small row-save" type="button">Submit & lock</button>`;
  return `<tr class="essay-grid-row" data-essay-number="${essayNumber}"><th scope="row">Essay ${essayNumber}</th>${scores}<td><span class="status-pill ${statusClass}">${status}</span></td><td>${action}</td></tr>`;
}

function render() {
  const {members, team_name} = team;
  const summary = summarizeTeam(members);
  const essayNumbers = members[0]?.essays.map(essay => essay.essay_number) || [];
  const essayCount = team.essay_count ?? essayNumbers.length;
  const maximum = members.length * essayCount;
  const complete = maximum > 0 && summary.submitted === maximum;
  const teamTotal = team.overall_score ?? summary.essayTotal + (team.extra_locked ? Number(team.extra_points || 0) : 0);
  dashboard.innerHTML = `
    <div class="dashboard-notice hidden" role="status"></div>
    <div class="dashboard-top">
      <div><p class="eyebrow">TEAM SCORE DASHBOARD</p><h1>${escapeHTML(team_name)}</h1></div>
      <div class="dashboard-actions"><button class="button button-secondary button-small" id="refresh-dashboard">Refresh</button><button class="button button-secondary button-small" id="team-sign-out">Sign out</button></div>
    </div>
    ${team.member_mapping_complete ? "" : '<div class="dashboard-notice error" role="alert">Some competitors could not be matched to the local name list. Unmapped records are labeled by competitor number; check data/teams.json before submitting scores.</div>'}
    <section class="progress-card">
      <div class="progress-line"><span>Essay submission progress</span><span>${summary.submitted} / ${maximum} Scores Submitted</span></div>
      <div class="progress-track" role="progressbar" aria-valuenow="${summary.submitted}" aria-valuemin="0" aria-valuemax="${maximum}"><div class="progress-fill" style="width:${maximum ? summary.submitted / maximum * 100 : 0}%"></div></div>
      <div class="progress-caption">${complete ? "All team essays are submitted and locked." : summary.submitted === 0 ? "Not started" : "In progress · Submit an essay row at a time."}</div>
    </section>
    <div class="team-totals"><div><span>Team total</span><strong>${formatScore(teamTotal)} <small>pts</small></strong></div></div>
    <section class="member-card team-essay-card"><div class="member-heading"><h2>Team essays</h2><span class="member-total">One row locks for every member</span></div>
      <div class="essay-table-wrap" tabindex="0" role="region" aria-label="Team essay scores"><table class="essay-table team-essay-table"><thead><tr><th scope="col">Essay</th>${members.map(member => `<th scope="col">${escapeHTML(member.display_name)}</th>`).join("")}<th scope="col">Status</th><th scope="col">Action</th></tr></thead>
      <tbody>${essayNumbers.map(number => renderEssayRow(number, members)).join("")}</tbody></table></div>
    </section>`;

  dashboard.querySelector("#team-sign-out").onclick = signOut;
  dashboard.querySelector("#refresh-dashboard").onclick = () => loadDashboard().catch(error => notice(error.message, "error"));
  dashboard.querySelectorAll(".raw-score").forEach(select => {
    select.addEventListener("change", () => {
      const row = select.closest("tr");
      try {
        const points = competitionPoints(select.value);
        select.closest(".grid-score-cell").querySelector(".points-output").textContent = points === null ? "—" : `${points} pts`;
      } catch {
        select.value = "";
        select.closest(".grid-score-cell").querySelector(".points-output").textContent = "—";
      }
    });
  });
  dashboard.querySelectorAll(".row-save").forEach(button => button.addEventListener("click", async () => {
    const row = button.closest("tr");
    const essayNumber = Number(row.dataset.essayNumber);
    const values = [...row.querySelectorAll(".raw-score")].map(select => {
      const member = team.members.find(item => Number(item.member_number) === Number(select.dataset.memberNumber));
      return select.disabled ? member?.essays.find(item => item.essay_number === essayNumber).raw_score : select.value;
    });
    if (values.some(value => value === "" || value === null)) return notice("Choose a score for every team member first.", "error");
    if (!confirm(`Submit and lock Essay ${essayNumber} for the whole team? Locked scores cannot be changed by the team.`)) return;
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const {error} = await client.rpc("submit_team_essay", {p_essay_number: essayNumber, p_raw_scores: values.map(Number)});
      if (error) throw error;
      await loadDashboard();
      notice(`Essay ${essayNumber} submitted and locked for the team.`);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Submit & lock";
      notice(error.message || "The essay could not be saved. Please retry.", "error");
    }
  }));
}

if (existingAdminAuth) window.location.replace("admin.html");
else if (auth) start();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && client && team) {
    loadDashboard().catch(error => notice(error.message, "error"));
  }
});

let checkingEssayCount = false;
setInterval(async () => {
  if (!client || !team || document.visibilityState !== "visible" || checkingEssayCount) return;
  checkingEssayCount = true;
  try {
    const {data, error} = await client.rpc("team_dashboard");
    if (error || !data) return;
    const currentCount = team.essay_count ?? team.members[0]?.essays.length;
    const savedCount = data.essay_count ?? data.members?.[0]?.essays.length;
    if (savedCount !== currentCount) await loadDashboard();
  } catch (error) {
    notice(error.message, "error");
  } finally {
    checkingEssayCount = false;
  }
}, 15000);

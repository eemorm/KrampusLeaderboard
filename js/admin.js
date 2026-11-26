import {createPrivateClient} from "./supabase.js";
import {formatScore} from "./scoring.js";
import {readToken, clearToken, escapeHTML, scoreOptions} from "./authentication.js";
import {loadTeamConfig, getTeamById, mapMembers} from "./team-config.js";

const dashboard = document.querySelector("#admin-dashboard");
const auth = readToken("admin");
let client = null;

async function start() {
  if (!auth) {
    window.location.replace("submit.html");
    return;
  }
  client = createPrivateClient(auth.token);
  dashboard.classList.remove("hidden");
  dashboard.innerHTML = '<div class="state-card"><span class="spinner" aria-hidden="true"></span>Loading scores…</div>';
  try {
    await load();
  } catch (error) {
    dashboard.innerHTML = `<div class="state-card error-state"><strong>Could not load scores.</strong>${escapeHTML(error.message)}<br><button class="button button-secondary button-small" id="admin-out">Sign in again</button></div>`;
    dashboard.querySelector("#admin-out").onclick = signOut;
  }
}

async function load() {
  const [overview, audit, config] = await Promise.all([
    client.rpc("admin_overview"),
    client.rpc("admin_audit_log", {p_limit: 30}),
    loadTeamConfig()
  ]);
  if (overview.error) throw overview.error;
  if (audit.error) throw audit.error;
  const teams = (overview.data || []).map(team => {
    const configuredTeam = getTeamById(config, team.id);
    const mapping = mapMembers(configuredTeam, team.members || []);
    return {...team, team_name: configuredTeam?.name || `Unmapped team (${team.id})`, members: mapping.members, member_mapping_complete: mapping.complete};
  });
  render(teams, audit.data || []);
}

function signOut() {
  clearToken("admin");
  window.location.replace("submit.html");
}

function render(teams, audit) {
  const essayCount = teams[0]?.essay_count ?? teams[0]?.members[0]?.essays.length ?? 0;
  dashboard.innerHTML = `
    <header class="admin-heading"><div><p class="eyebrow">ADMIN</p><h1 class="admin-title">Competition scores</h1></div><div class="admin-heading-actions"><div class="essay-count-control"><span class="essay-count-title">Number of Essays</span><div class="essay-stepper"><button id="admin-remove-essay" type="button" aria-label="Remove latest essay" ${essayCount <= 1 ? "disabled" : ""}>−</button><output aria-live="polite">${essayCount}</output><button id="admin-add-essay" type="button" aria-label="Add essay" ${essayCount >= 32767 ? "disabled" : ""}>+</button></div></div><button class="button button-secondary button-small" id="admin-sign-out">Sign out</button></div></header>
    <div class="dashboard-notice hidden" role="status"></div>
    <div id="admin-teams">${teams.map(renderTeam).join("")}</div>
    <section class="admin-audit"><h2>Recent changes</h2><div class="audit-list">${audit.length ? audit.map(renderAudit).join("") : "No changes recorded."}</div></section>`;
  dashboard.querySelector("#admin-sign-out").onclick = signOut;
  const changeEssayCount = async direction => {
    const adding = direction === 1;
    const prompt = adding
      ? `Add Essay ${essayCount + 1} for every team member?`
      : `Remove Essay ${essayCount} for every team member? Only an essay with no saved scores or exclusions can be removed.`;
    if (!confirm(prompt)) return;
    const buttons = dashboard.querySelectorAll(".essay-stepper button");
    buttons.forEach(button => button.disabled = true);
    let savedCount;
    try {
      const {data, error} = await client.rpc(adding ? "admin_add_essay" : "admin_remove_essay");
      if (error) throw error;
      savedCount = data;
    } catch (error) {
      buttons.forEach(button => button.disabled = button.id === "admin-remove-essay" ? essayCount <= 1 : essayCount >= 32767);
      notice(error.message || "The essay count could not be changed.", "error");
      return;
    }
    try {
      await load();
      notice(adding ? `Essay ${savedCount} added for every team member.` : `Essay ${essayCount} removed for every team member.`);
    } catch (error) {
      notice(`Essay count saved as ${savedCount}, but the dashboard could not refresh: ${error.message}`, "error");
    }
  };
  dashboard.querySelector("#admin-add-essay").onclick = () => changeEssayCount(1);
  dashboard.querySelector("#admin-remove-essay").onclick = () => changeEssayCount(-1);
  dashboard.querySelectorAll(".admin-toggle").forEach(button => {
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.closest(".admin-team").querySelector(".admin-team-detail").classList.toggle("hidden", expanded);
      button.textContent = expanded ? "Show scores" : "Hide scores";
    });
  });
  bindEssayActions();
  bindExtraActions();
}

function renderTeam(team) {
  const mayDropEssay = team.members.length === 5;
  const excludedByEssay = Object.fromEntries(team.members.flatMap(member => member.essays.filter(essay => essay.is_dropped).map(essay => [essay.essay_number, essay])));
  const excludedCount = Object.keys(excludedByEssay).length;
  const essayNumbers = team.members[0]?.essays.map(essay => essay.essay_number) || [];
  return `<section class="admin-team" data-team="${team.id}">
    <div class="admin-team-summary">
      <div class="admin-team-name">${escapeHTML(team.team_name)}</div>
      <div class="admin-metric">Team score<strong>${formatScore(team.overall_score)} pts</strong></div>
      <div class="admin-metric">Essays<strong>${team.submitted_essays} / ${team.maximum_essays}</strong></div>
      <div class="admin-metric">Extra points<strong>${team.extra_locked ? "Locked" : "Pending"} · ${extraPointsLabel(team, "—")}</strong></div>
      <button class="admin-toggle" type="button" aria-expanded="false">Show scores</button>
    </div>
    ${team.member_mapping_complete ? "" : '<p class="drop-rule">Some competitors could not be matched to data/teams.json. Unmapped records are labeled by competitor number.</p>'}
    <div class="admin-team-detail hidden">
      ${mayDropEssay ? `<p class="drop-rule">Choose one member’s score to exclude for each essay. ${excludedCount} / ${essayNumbers.length} selected.</p>` : ""}
      <div class="admin-grid-wrap" tabindex="0" role="region" aria-label="${escapeHTML(team.team_name)} essay scores"><table class="admin-grid-table"><thead><tr><th scope="col">Essay</th>${team.members.map(member => `<th scope="col">${escapeHTML(member.display_name)}</th>`).join("")}${mayDropEssay ? '<th scope="col">Excluded member</th>' : ""}<th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>${essayNumbers.map(number => renderEssayRow(team, number, mayDropEssay, excludedByEssay[number])).join("")}</tbody></table></div>
      ${renderExtras(team)}
    </div>
  </section>`;
}

function renderEssayRow(team, essayNumber, mayDropEssay, excludedEssay) {
  const essays = team.members.map(member => member.essays.find(essay => essay.essay_number === essayNumber));
  const lockedCount = essays.filter(essay => essay.is_locked).length;
  const fullyLocked = lockedCount === essays.length;
  const missingCount = essays.filter(essay => essay.raw_score === null).length;
  const status = fullyLocked ? "Locked" : lockedCount ? `Partially locked · ${lockedCount}/${essays.length}` : "Unlocked";
  const scores = essays.map((essay, index) => `<td><div class="admin-grid-score"><select class="admin-score-select" data-member-number="${team.members[index].member_number}" data-current-score="${essay.raw_score ?? ""}" aria-label="${escapeHTML(team.members[index].display_name)} essay ${essayNumber} score">${scoreOptions(essay.raw_score)}</select><span class="admin-points">${essay.competition_points === null ? "—" : `${essay.competition_points} pts`}</span></div></td>`).join("");
  const exclusion = mayDropEssay
    ? `<td><div class="admin-exclusion"><select class="admin-drop-choice" aria-label="Member excluded for essay ${essayNumber}" ${fullyLocked ? "" : "disabled"}><option value="">Choose member</option>${essays.map((essay, index) => `<option value="${essay.id}" ${essay.is_dropped ? "selected" : ""}>${escapeHTML(team.members[index].display_name)}</option>`).join("")}</select><button class="button button-secondary button-small admin-save-drop" type="button" data-current-drop="${excludedEssay?.id || ""}" ${fullyLocked ? "" : "disabled"}>Save choice</button></div></td>`
    : "";
  const lockText = fullyLocked ? "Unlock essay" : lockedCount ? "Lock all" : "Lock essay";
  return `<tr class="admin-grid-row" data-essay-number="${essayNumber}" data-team="${team.id}" data-locked="${fullyLocked}" data-locked-count="${lockedCount}" data-member-count="${essays.length}" data-missing-count="${missingCount}" data-essay-ids="${essays.map(essay => essay.id).join(",")}"><th scope="row">Essay ${essayNumber}</th>${scores}${exclusion}<td><span class="status-pill ${fullyLocked ? "locked" : ""}">${status}</span></td><td><div class="admin-row-actions"><button class="button button-secondary button-small admin-save-row" type="button">Save scores</button><button class="button ${fullyLocked ? "button-secondary" : "button-primary"} button-small admin-group-lock" type="button" data-lock="${!fullyLocked}" ${!fullyLocked && missingCount ? "disabled title=\"Enter every member score before locking\"" : ""}>${lockText}</button></div></td></tr>`;
}

function renderExtras(team) {
  return `<div class="admin-extras">
    <div>Team extra points: <strong>${extraPointsLabel(team, "Not submitted")}</strong> · ${team.extra_locked ? "Locked" : "Unlocked"}</div>
    <div class="admin-essay-actions">${team.extra_locked
      ? '<button class="button button-secondary button-small admin-unlock-extra" type="button">Unlock extra points</button>'
      : `<input class="admin-extra-value" type="number" step="1" value="${team.extra_points ?? ""}" placeholder="Whole points" aria-label="Edit team extra points">
         <button class="button button-secondary button-small admin-save-extra" type="button">Save points</button>
         <button class="button button-primary button-small admin-lock-extra" type="button">Lock points</button>`}
    </div>
  </div>`;
}

function extraPointsLabel(team, emptyLabel) {
  return team.extra_points === null || (!team.extra_locked && team.extra_points === 0)
    ? emptyLabel
    : formatScore(team.extra_points);
}

function renderAudit(item) {
  const action = String(item.action || "change").replaceAll("_", " ");
  return `<div class="audit-item"><strong>${escapeHTML(action)}</strong> · ${escapeHTML(item.team_name || "Competition")} · ${new Date(item.created_at).toLocaleString()}<br><span>${escapeHTML(JSON.stringify({previous: item.previous_value, next: item.new_value}))}</span></div>`;
}

function bindEssayActions() {
  dashboard.querySelectorAll(".admin-save-row").forEach(button => {
    button.onclick = async () => {
      const row = button.closest(".admin-grid-row");
      const selects = [...row.querySelectorAll(".admin-score-select")];
      const changed = selects.filter(select => select.value !== select.dataset.currentScore);
      if (!changed.length) return notice("No score changes to save. Choose a score, or choose the blank option to clear an existing score for team resubmission.", "error");
      const cleared = changed.filter(select => select.value === "");
      const memberNames = cleared.map(select => select.closest("td").querySelector("select").getAttribute("aria-label").replace(/ essay \d+ score$/, ""));
      const confirmation = row.dataset.locked === "true"
        ? `Save score corrections for Essay ${row.dataset.essayNumber}? Existing locks will remain in place.`
        : `Save score changes for Essay ${row.dataset.essayNumber}? Existing locks will remain in place.`;
      const clearMessage = cleared.length ? ` Choosing the blank option will clear ${memberNames.join(", ")} and unlock that score for team resubmission. Other populated scores in this row will be locked.` : "";
      if (!confirm(`${confirmation}${clearMessage} The change will be recorded.`)) return;
      await modify("admin_set_team_essay_scores", {p_team_id: row.dataset.team, p_essay_number: Number(row.dataset.essayNumber), p_raw_scores: selects.map(select => select.value === "" ? null : Number(select.value))});
    };
  });
  dashboard.querySelectorAll(".admin-group-lock").forEach(button => {
    button.onclick = async () => {
      const row = button.closest(".admin-grid-row");
      const lock = button.dataset.lock === "true";
      if (lock && Number(row.dataset.missingCount)) return notice("Choose or clear the missing scores before locking this essay.", "error");
      if (!confirm(`${lock ? "Lock all member scores" : "Unlock all member scores"} for Essay ${row.dataset.essayNumber}? This change will be recorded.`)) return;
      await modify("admin_set_team_essay_lock", {p_team_id: row.dataset.team, p_essay_number: Number(row.dataset.essayNumber), p_locked: lock});
    };
  });
  dashboard.querySelectorAll(".admin-save-drop").forEach(button => {
    button.onclick = async () => {
      const row = button.closest(".admin-grid-row");
      const selected = row.querySelector(".admin-drop-choice").value;
      const previous = button.dataset.currentDrop;
      if (selected === previous) return notice("No exclusion change to save.", "error");
      if (!selected && !previous) return notice("Choose a member to exclude.", "error");
      const target = selected || previous;
      const prompt = !selected
        ? `Restore the excluded score for Essay ${row.dataset.essayNumber}?`
        : previous
          ? `Replace the current selection for Essay ${row.dataset.essayNumber} with the chosen member? Both changes will be recorded.`
          : `Exclude the chosen member’s score for Essay ${row.dataset.essayNumber}?`;
      if (!confirm(`${prompt} This change will be recorded.`)) return;
      await modify("admin_set_essay_dropped", {p_essay_id: target, p_dropped: Boolean(selected)});
    };
  });
}

function bindExtraActions() {
  dashboard.querySelectorAll(".admin-unlock-extra").forEach(button => {
    button.onclick = async () => {
      if (!confirm("Unlock team extra points and clear the submitted value for an administrator correction? This action will be recorded.")) return;
      await modify("admin_set_extra_lock", {p_team_id: button.closest(".admin-team").dataset.team, p_locked: false});
    };
  });
  dashboard.querySelectorAll(".admin-save-extra").forEach(button => {
    button.onclick = async () => {
      const input = button.closest(".admin-extras").querySelector(".admin-extra-value");
      const value = Number(input.value);
      if (input.value === "" || !Number.isInteger(value)) return notice("Enter a whole number.", "error");
      if (!confirm("Save these team extra points? The change will be recorded.")) return;
      await modify("admin_set_extra_points", {p_team_id: button.closest(".admin-team").dataset.team, p_points: value});
    };
  });
  dashboard.querySelectorAll(".admin-lock-extra").forEach(button => {
    button.onclick = async () => {
      if (!confirm("Lock these team extra points?")) return;
      await modify("admin_set_extra_lock", {p_team_id: button.closest(".admin-team").dataset.team, p_locked: true});
    };
  });
}

function notice(message, type = "success") {
  const node = dashboard.querySelector(".dashboard-notice");
  node.textContent = message;
  node.className = `dashboard-notice ${type}`;
}

async function modify(rpc, args) {
  try {
    const {error} = await client.rpc(rpc, args);
    if (error) throw error;
    await load();
    notice("Saved and recorded.");
  } catch (error) {
    notice(error.message || "The change could not be saved.", "error");
  }
}

start();

import {isConfigured, configurationMessage, login, createPrivateClient} from "./supabase.js";
import {formatScore} from "./scoring.js";
import {readToken, storeToken, clearToken, escapeHTML, scoreOptions} from "./authentication.js";

const loginPanel = document.querySelector("#admin-login");
const dashboard = document.querySelector("#admin-dashboard");
const form = document.querySelector("#admin-login-form");
const errorBox = document.querySelector("#admin-login-error");
let auth = readToken("admin");
let client = null;

form.addEventListener("submit", async event => {
  event.preventDefault();
  errorBox.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    if (!isConfigured()) throw new Error(configurationMessage());
    auth = await login(document.querySelector("#admin-pin").value, "admin");
    storeToken("admin", auth);
    await start();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

async function start() {
  if (!auth) return;
  client = createPrivateClient(auth.token);
  loginPanel.classList.add("hidden");
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
  const [overview, audit] = await Promise.all([
    client.rpc("admin_overview"),
    client.rpc("admin_audit_log", {p_limit: 30})
  ]);
  if (overview.error) throw overview.error;
  if (audit.error) throw audit.error;
  render(overview.data, audit.data || []);
}

function signOut() {
  clearToken("admin");
  auth = null;
  client = null;
  dashboard.classList.add("hidden");
  loginPanel.classList.remove("hidden");
  document.querySelector("#admin-pin").value = "";
}

function render(teams, audit) {
  dashboard.innerHTML = `
    <header class="admin-heading">
      <div>
        <p class="eyebrow">ADMIN</p>
        <h1 class="admin-title">Competition scores</h1>
      </div>
      <button class="button button-secondary button-small" id="admin-sign-out">Sign out</button>
    </header>
    <div class="dashboard-notice hidden" role="status"></div>
    <div id="admin-teams">${teams.map(renderTeam).join("")}</div>
    <section class="admin-audit">
      <h2>Recent changes</h2>
      <div class="audit-list">${audit.length ? audit.map(renderAudit).join("") : "No changes recorded."}</div>
    </section>`;

  dashboard.querySelector("#admin-sign-out").onclick = signOut;
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
  const mayDropEssay = team.maximum_essays === 75;
  const excludedByEssay = Object.fromEntries(team.members.flatMap(member => member.essays.filter(essay => essay.is_dropped).map(essay => [essay.essay_number, member.member_name])));
  const excludedCount = Object.keys(excludedByEssay).length;
  return `<section class="admin-team" data-team="${team.id}">
    <div class="admin-team-summary">
      <div class="admin-team-name">${escapeHTML(team.team_name)}</div>
      <div class="admin-metric">Team score<strong>${formatScore(team.overall_score)} pts</strong></div>
      <div class="admin-metric">Essays<strong>${team.submitted_essays} / ${team.maximum_essays}</strong></div>
      <div class="admin-metric">Extra points<strong>${team.extra_locked ? "Locked" : "Pending"} · ${team.extra_points === null ? "—" : formatScore(team.extra_points)}</strong></div>
      <button class="admin-toggle" type="button" aria-expanded="false">Show scores</button>
    </div>
    <div class="admin-team-detail hidden">
      ${mayDropEssay ? `<p class="drop-rule">Choose one member’s score to exclude for each essay. ${excludedCount} / 15 selected.</p>` : ""}
      <div class="admin-members">${team.members.map(member => renderMember(member, mayDropEssay, excludedByEssay)).join("")}</div>
      ${renderExtras(team)}
    </div>
  </section>`;
}

function renderMember(member, mayDropEssay, excludedByEssay) {
  return `<section class="admin-member" data-member="${member.id}">
    <h3>${escapeHTML(member.member_name)}<span>${formatScore(member.member_total)} pts</span></h3>
    <div class="admin-essays">${member.essays.map(essay => renderEssay(essay, mayDropEssay, excludedByEssay)).join("")}</div>
  </section>`;
}

function renderEssay(essay, mayDropEssay, excludedByEssay) {
  const value = essay.raw_score === null ? "Not submitted" : `${essay.raw_score}/6 · ${essay.competition_points} pts`;
  const scoreEditor = `<select class="admin-score-select" aria-label="Essay ${essay.essay_number} raw score">${scoreOptions(essay.raw_score)}</select>
    <button class="button button-secondary button-small admin-save-score" type="button" disabled>${essay.is_locked ? "Save correction" : "Save score"}</button>`;
  const lockControl = essay.is_locked
    ? '<button class="button button-secondary button-small admin-unlock" type="button">Unlock essay</button>'
    : '<button class="button button-primary button-small admin-lock" type="button">Lock essay</button>';
  const previousChoice = excludedByEssay[essay.essay_number];
  const dropControl = mayDropEssay && essay.is_locked && essay.raw_score !== null
    ? `<button class="button button-secondary button-small admin-drop-essay" type="button" data-dropped="${Boolean(essay.is_dropped)}" data-essay-number="${essay.essay_number}" data-previous-choice="${escapeHTML(previousChoice || "")}">${essay.is_dropped ? "Include in total" : previousChoice ? "Choose this member" : "Exclude score"}</button>`
    : "";
  return `<div class="admin-essay-row" data-essay="${essay.id}" data-current-score="${essay.raw_score ?? ""}" data-locked="${Boolean(essay.is_locked)}">
    <div class="admin-essay-label">Essay ${essay.essay_number}</div>
    <div class="admin-essay-value">${value}${essay.is_dropped ? '<span class="excluded-label">Excluded from total</span>' : ""}</div>
    <div class="admin-essay-actions">${scoreEditor}${lockControl}${dropControl}</div>
  </div>`;
}

function renderExtras(team) {
  return `<div class="admin-extras">
    <div>Team extra points: <strong>${team.extra_points === null ? "Not submitted" : formatScore(team.extra_points)}</strong> · ${team.extra_locked ? "Locked" : "Unlocked"}</div>
    <div class="admin-essay-actions">${team.extra_locked
      ? '<button class="button button-secondary button-small admin-unlock" data-kind="extra" type="button">Unlock extra points</button>'
      : `<input class="admin-extra-value" type="number" step="1" value="${team.extra_points ?? ""}" placeholder="Whole points" aria-label="Edit team extra points">
         <button class="button button-secondary button-small admin-save-extra" type="button">Save points</button>
         <button class="button button-primary button-small admin-lock-extra" type="button">Lock points</button>`}
    </div>
  </div>`;
}

function renderAudit(item) {
  const action = String(item.action || "change").replaceAll("_", " ");
  return `<div class="audit-item"><strong>${escapeHTML(action)}</strong> · ${escapeHTML(item.team_name || "Competition")} · ${new Date(item.created_at).toLocaleString()}<br><span>${escapeHTML(JSON.stringify({previous: item.previous_value, next: item.new_value}))}</span></div>`;
}

function bindEssayActions() {
  dashboard.querySelectorAll(".admin-score-select").forEach(select => {
    select.addEventListener("change", () => {
      const row = select.closest(".admin-essay-row");
      const save = row.querySelector(".admin-save-score");
      save.disabled = select.value === "" || select.value === row.dataset.currentScore;
    });
  });
  dashboard.querySelectorAll(".admin-unlock:not([data-kind='extra'])").forEach(button => {
    button.onclick = async () => {
      const row = button.closest(".admin-essay-row");
      if (!confirm("Unlock this essay so its score can be corrected? This action will be recorded.")) return;
      await modify("admin_set_essay_lock", {p_essay_id: row.dataset.essay, p_locked: false});
    };
  });
  dashboard.querySelectorAll(".admin-save-score").forEach(button => {
    button.onclick = async () => {
      const row = button.closest(".admin-essay-row");
      const value = row.querySelector(".admin-score-select").value;
      if (value === "") return notice("Choose a score first.", "error");
      const confirmation = row.dataset.locked === "true"
        ? "Save this score correction? The essay will remain locked and the change will be recorded."
        : "Save this score? The essay will remain unlocked until you lock it. The change will be recorded.";
      if (!confirm(confirmation)) return;
      await modify("admin_set_essay_score", {p_essay_id: row.dataset.essay, p_raw_score: Number(value)});
    };
  });
  dashboard.querySelectorAll(".admin-lock").forEach(button => {
    button.onclick = async () => {
      if (!confirm("Lock this essay? Teams cannot change a locked essay.")) return;
      await modify("admin_set_essay_lock", {p_essay_id: button.closest(".admin-essay-row").dataset.essay, p_locked: true});
    };
  });
  dashboard.querySelectorAll(".admin-drop-essay").forEach(button => {
    button.onclick = async () => {
      const dropped = button.dataset.dropped === "true";
      const prompt = dropped
        ? `Restore this member’s Essay ${button.dataset.essayNumber} score to the team total? This change will be recorded.`
        : button.dataset.previousChoice
          ? `Choose this member instead of ${button.dataset.previousChoice} for Essay ${button.dataset.essayNumber}? The previous selection will be replaced and both changes recorded.`
          : `Exclude this member’s Essay ${button.dataset.essayNumber} score from the team total? This change will be recorded.`;
      if (!confirm(prompt)) return;
      await modify("admin_set_essay_dropped", {
        p_essay_id: button.closest(".admin-essay-row").dataset.essay,
        p_dropped: !dropped
      });
    };
  });
}

function bindExtraActions() {
  dashboard.querySelectorAll(".admin-unlock[data-kind=extra]").forEach(button => {
    button.onclick = async () => {
      if (!confirm("Unlock team extra points for correction? This action will be recorded.")) return;
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

if (auth) start();

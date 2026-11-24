import {POINTS, ESSAYS_PER_MEMBER} from "./config.js";
export function competitionPoints(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || !Object.hasOwn(POINTS, value)) throw new RangeError("Essay score must be an integer from 0 through 5.");
  return POINTS[value];
}
export function formatScore(value) {
  return new Intl.NumberFormat("en-US", {maximumFractionDigits: 2}).format(Number(value) || 0);
}
export function summarizeTeam(members, extraPoints = 0) {
  const memberTotals = members.map(member => (member.essays || []).filter(essay => essay.is_locked).reduce((sum, essay) => sum + (essay.competition_points ?? 0), 0));
  const essayTotal = members.reduce((sum, member) => sum + (member.essays || []).filter(essay => essay.is_locked && !essay.is_dropped).reduce((memberSum, essay) => memberSum + (essay.competition_points ?? 0), 0), 0);
  const submitted = members.reduce((sum, member) => sum + (member.essays || []).filter(essay => essay.is_locked).length, 0);
  return {memberTotals, essayTotal, total: essayTotal + Number(extraPoints || 0), submitted, maximum: members.length * ESSAYS_PER_MEMBER};
}
export function rankTeams(teams) {
  const sorted=[...teams].sort((a,b)=>Number(b.overall_score||0)-Number(a.overall_score||0)||String(a.team_name).localeCompare(String(b.team_name)));
  let previous=null,rank=0;
  return sorted.map((team,index)=>{const score=Number(team.overall_score||0);if(score!==previous)rank=index+1;previous=score;return{...team,rank};});
}

import test from "node:test";
import assert from "node:assert/strict";
import {competitionPoints,summarizeTeam,rankTeams} from "../js/scoring.js";
import {SUPABASE_URL,API_FUNCTION_URL} from "../js/config.js";

test("converts every allowed raw essay score using the competition table",()=>{
  assert.deepEqual([0,1,2,3,4,5].map(competitionPoints),[0,0,9,13,15,18]);
  assert.equal(competitionPoints(""),null);
});

test("rejects score 6 and non-integer or malformed values",()=>{
  for(const invalid of [6,-1,1.5,"five",NaN])assert.throws(()=>competitionPoints(invalid),RangeError);
});

test("calculates member/team totals and submission progress without extra points in member totals",()=>{
  const members=Array.from({length:5},(_,member)=>({essays:Array.from({length:15},(_,essay)=>({competition_points:member===0&&essay<2?18:0,is_locked:member===0&&essay<2}))}));
  const summary=summarizeTeam(members,-3);
  assert.deepEqual(summary.memberTotals,[36,0,0,0,0]);
  assert.equal(summary.essayTotal,36);
  assert.equal(summary.total,33);
  assert.equal(summary.submitted,2);
  assert.equal(summary.maximum,75);
  assert.equal(summarizeTeam(members).maximum,75);
  assert.equal(summarizeTeam(members.slice(0,4)).maximum,60);
});

test("excludes the teacher-selected essay from totals while retaining it in submitted progress",()=>{
  const members=Array.from({length:5},(_,member)=>({essays:Array.from({length:15},(_,essay)=>({competition_points:18,is_locked:member===2&&essay<2,is_dropped:member===2&&essay===0}))}));
  const summary=summarizeTeam(members,0);
  assert.deepEqual(summary.memberTotals,[0,0,36,0,0]);
  assert.equal(summary.essayTotal,18);
  assert.equal(summary.submitted,2);
  assert.equal(summary.maximum,75);
});

test("supports one excluded member score for each of the five-person team’s 15 essays",()=>{
  const members=Array.from({length:5},(_,member)=>({essays:Array.from({length:15},(_,essay)=>({competition_points:18,is_locked:true,is_dropped:essay%5===member}))}));
  const summary=summarizeTeam(members,0);
  assert.deepEqual(summary.memberTotals,[270,270,270,270,270]);
  assert.equal(summary.essayTotal,1080);
  assert.equal(summary.submitted,75);
  assert.equal(summary.maximum,75);
});

test("sorts descending and uses competition ranking for ties",()=>{
  const ranked=rankTeams([{team_name:"Team C",overall_score:80},{team_name:"Team B",overall_score:80},{team_name:"Team D",overall_score:25},{team_name:"Team A",overall_score:100}]);
  assert.deepEqual(ranked.map(team=>[team.team_name,team.rank]),[["Team A",1],["Team B",2],["Team C",2],["Team D",4]]);
});

test("matches the seven-team, 29-competitor, 435-essay structure",()=>{
  const teamSizes=[4,4,4,4,4,4,5];
  assert.equal(teamSizes.length,7);
  assert.equal(teamSizes.reduce((sum,size)=>sum+size,0),29);
  assert.equal(teamSizes.reduce((sum,size)=>sum+size*15,0),435);
});

test("keeps Supabase endpoints rooted at the project URL",()=>{
  assert.equal(SUPABASE_URL.endsWith("/rest/v1"),false);
  assert.equal(API_FUNCTION_URL,`${SUPABASE_URL}/functions/v1/competition-api`);
});

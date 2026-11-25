const configUrl = new URL("../data/teams.json", import.meta.url);
let configPromise;

export function loadTeamConfig() {
  configPromise ||= fetch(configUrl).then(response => {
    if (!response.ok) throw new Error(`Team display names could not be loaded (${response.status}).`);
    return response.json();
  }).then(config => {
    if (!Array.isArray(config.teams)) throw new Error("Team display-name configuration is invalid.");
    return config;
  });
  return configPromise;
}

export function getTeamById(config, id) {
  return config.teams.find(team => team.id === id) || null;
}

export function mapMembers(configTeam, records) {
  const names = new Map((configTeam?.members || []).map(member => [Number(member.member_number), member.name]));
  const numbers = records.map(member => Number(member.member_number));
  const unique = new Set(numbers);
  const validNumbers = numbers.every(number => Number.isInteger(number) && number > 0 && names.has(number));
  const complete = validNumbers && unique.size === records.length && records.length === names.size;
  const members = [...records].sort((a, b) => Number(a.member_number) - Number(b.member_number)).map(member => ({
    ...member,
    display_name: validNumbers ? names.get(Number(member.member_number)) : `Unmapped competitor #${member.member_number ?? "?"}`
  }));
  return {members, complete};
}

export function publicTeamName(config, databaseName) {
  const matches = config.teams.filter(team => team.database_name === databaseName);
  return matches.length === 1 ? matches[0].name : null;
}

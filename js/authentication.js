export function escapeHTML(value) { return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
export function readToken(role) { try { const item=JSON.parse(sessionStorage.getItem(`krampus-${role}`)); if (!item || item.expires_at*1000 < Date.now()) {sessionStorage.removeItem(`krampus-${role}`);return null;} return item; } catch { return null; } }
export function storeToken(role, data) { sessionStorage.setItem(`krampus-${role}`,JSON.stringify(data)); }
export function clearToken(role) { sessionStorage.removeItem(`krampus-${role}`); }
export function scoreOptions(selected = "") {return `<option value="" ${selected===""?"selected":""}>Choose…</option>${[0,1,2,3,4,5].map(n=>`<option value="${n}" ${String(selected)===String(n)?"selected":""}>${n}/6</option>`).join("")}`;}

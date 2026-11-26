// These values are public by design. Configure them after creating the Supabase project.
// Use the project root URL from Supabase settings. The REST and Functions paths
// are appended by the SDK and API client below; pasted /rest/v1 URLs are normalized.
const configuredProjectUrl = "https://jfbxexflqgfycskaukjp.supabase.co";
export const SUPABASE_URL = configuredProjectUrl.replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
export const SUPABASE_ANON_KEY = "sb_publishable_B8CVznuzBJ33Fxo9PYUBTw_9K_PW8Ff";
export const API_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/competition-api`;
export const POINTS = Object.freeze({0: 0, 1: 0, 2: 9, 3: 13, 4: 15, 5: 18});

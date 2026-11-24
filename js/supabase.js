import {createClient} from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import {SUPABASE_URL, SUPABASE_ANON_KEY, API_FUNCTION_URL} from "./config.js";
export function isConfigured() { return !SUPABASE_URL.includes("YOUR_PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR_"); }
export function createPublicClient() { return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}); }
export function createPrivateClient(token) { return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:`Bearer ${token}`}}}); }
export async function login(pin, role) {
  const response = await fetch(API_FUNCTION_URL, {method:"POST",headers:{"Content-Type":"application/json","apikey":SUPABASE_ANON_KEY},body:JSON.stringify({action:"login",pin,role})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not sign in. Check the PIN and try again.");
  return data;
}
export function configurationMessage() { return "Supabase is not configured yet. Add the project URL and public anon key in js/config.js, then reload."; }

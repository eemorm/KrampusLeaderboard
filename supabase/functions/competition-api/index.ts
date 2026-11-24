import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bootstrap-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers:{...cors,"Content-Type":"application/json"}});
const env = (name: string) => Deno.env.get(name) ?? "";
const supabaseUrl = env("SUPABASE_URL");
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
const jwtSecret = env("SUPABASE_JWT_SECRET");
const service = createClient(supabaseUrl, serviceKey, {auth:{persistSession:false,autoRefreshToken:false}});

function encodeBase64Url(bytes: Uint8Array): string {
  let binary="";
  for (const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");
}
function textBase64Url(value: string): string { return encodeBase64Url(new TextEncoder().encode(value)); }
async function hmacJwt(claims: Record<string,unknown>): Promise<string> {
  if (!jwtSecret) throw new Error("JWT signing secret is not configured");
  const header=textBase64Url(JSON.stringify({alg:"HS256",typ:"JWT"}));
  const payload=textBase64Url(JSON.stringify(claims));
  const message=`${header}.${payload}`;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(jwtSecret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(message)));
  return `${message}.${encodeBase64Url(signature)}`;
}
function randomSalt(): Uint8Array { return crypto.getRandomValues(new Uint8Array(16)); }
async function pinHash(pin: string, salt: Uint8Array): Promise<string> {
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:310000,hash:"SHA-256"},material,256);
  return encodeBase64Url(new Uint8Array(bits));
}
function decodeBase64Url(value: string): Uint8Array {
  const padded=value.replaceAll("-","+").replaceAll("_","/")+"===".slice((value.length+3)%4);
  return Uint8Array.from(atob(padded),char=>char.charCodeAt(0));
}
async function verifyPin(pin:string,salt:string,expected:string):Promise<boolean>{
  const actual=await pinHash(pin,decodeBase64Url(salt));
  const left=decodeBase64Url(actual),right=decodeBase64Url(expected);
  if(left.length!==right.length)return false;
  let difference=0;for(let i=0;i<left.length;i++)difference|=left[i]^right[i];return difference===0;
}
async function attemptKey(request:Request,role:string):Promise<string>{
  const forwarded=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||request.headers.get("cf-connecting-ip")||"unknown";
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${role}:${forwarded}`));
  return encodeBase64Url(new Uint8Array(bytes));
}

Deno.serve(async request=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(request.method!=="POST")return json({error:"Method not allowed"},405);
  try{
    const body=await request.json();
    if(body.action==="setup")return await configureCredentials(request,body);
    if(body.action!=="login")return json({error:"Unknown action"},400);
    const role=body.role;
    if(role!=="team"&&role!=="admin")return json({error:"Invalid sign-in request"},400);
    const pin=typeof body.pin==="string"?body.pin.trim():"";
    if(pin.length<4||pin.length>64)return json({error:"Enter a valid PIN."},400);
    const key=await attemptKey(request,role);
    const {data:allowed,error:rateError}=await service.rpc("auth_attempt_allowed",{p_key:key});
    if(rateError)throw rateError;
    if(!allowed)return json({error:"Too many attempts. Please wait 15 minutes before trying again."},429);
    let identity:{id:string;salt:string;hash:string;teamName?:string}|null=null;
    if(role==="team"){
      const {data:credentials,error}=await service.from("team_credentials").select("team_id,pin_salt,pin_hash,teams(team_name)");
      if(error)throw error;
      if(!credentials?.length)return json({error:"Team PINs have not been initialized. Ask the competition administrator to complete setup."},503);
      for(const item of credentials??[]){
        if(await verifyPin(pin,item.pin_salt,item.pin_hash)){
          identity={id:item.team_id,salt:item.pin_salt,hash:item.pin_hash,teamName:(item.teams as {team_name:string}|null)?.team_name};break;
        }
      }
    }else{
      const {data:item,error}=await service.from("admin_credentials").select("admin_id,pin_salt,pin_hash").eq("singleton",true).maybeSingle();
      if(error)throw error;
      if(!item)return json({error:"The administrator PIN has not been initialized. Complete the one-time credential setup first."},503);
      if(item&&await verifyPin(pin,item.pin_salt,item.pin_hash))identity={id:item.admin_id,salt:item.pin_salt,hash:item.pin_hash};
    }
    if(!identity)return json({error:"That PIN could not be verified."},401);
    await service.rpc("auth_clear_attempt",{p_key:key});
    const now=Math.floor(Date.now()/1000),expiresAt=now+1800;
    const token=await hmacJwt({iss:`${supabaseUrl}/auth/v1`,aud:"authenticated",iat:now,exp:expiresAt,sub:identity.id,role:"authenticated",app_metadata:role==="team"?{competition_role:"team",team_id:identity.id}:{competition_role:"admin"}});
    return json({token,expires_at:expiresAt,team_name:identity.teamName??null});
  }catch(error){
    console.error("competition-api failure",error);
    return json({error:"The secure service is temporarily unavailable. Please try again."},500);
  }
});

async function configureCredentials(request:Request,body:Record<string,unknown>):Promise<Response>{
  const bootstrap=env("COMPETITION_BOOTSTRAP_SECRET");
  const supplied=request.headers.get("x-bootstrap-secret")??"";
  if(!bootstrap||supplied.length!==bootstrap.length)return json({error:"Setup authorization failed."},403);
  let matched=0;for(let index=0;index<bootstrap.length;index++)matched|=bootstrap.charCodeAt(index)^supplied.charCodeAt(index);
  if(matched!==0)return json({error:"Setup authorization failed."},403);
  const adminPin=typeof body.adminPin==="string"?body.adminPin.trim():"";
  const pinMap=body.teamPins;
  if(adminPin.length<8||!pinMap||typeof pinMap!=="object")return json({error:"Provide an administrator PIN of at least 8 characters and all seven team PINs."},400);
  const {data:teams,error:teamError}=await service.from("teams").select("id,team_name");
  if(teamError)throw teamError;
  if((teams??[]).length!==7)return json({error:"The database must contain all seven teams before credential setup."},400);
  const entries=teams!.map(team=>({team,pin:(pinMap as Record<string,unknown>)[team.team_name]}));
  if(entries.some(item=>typeof item.pin!=="string"||(item.pin as string).trim().length<4||(item.pin as string).trim().length>64))return json({error:"Enter a unique PIN of at least 4 characters for every configured team."},400);
  const allPins=entries.map(item=>(item.pin as string).trim());
  if(new Set([...allPins,adminPin]).size!==8)return json({error:"Each team PIN and the administrator PIN must be unique."},400);
  const {data:claimed,error:claimError}=await service.rpc("claim_credential_setup");
  if(claimError)throw claimError;
  if(!claimed)return json({error:"Credentials have already been initialized. Reset the setup flag from the Supabase SQL Editor before reinitializing."},409);
  const hashCredential=async(pin:string)=>{const salt=randomSalt();return{pin_salt:encodeBase64Url(salt),pin_hash:await pinHash(pin,salt)};};
  const credentials=[];
  for(const {team,pin} of entries)credentials.push({team_id:team.id,...await hashCredential((pin as string).trim())});
  const admin={singleton:true,admin_id:crypto.randomUUID(),...await hashCredential(adminPin)};
  const {error:teamWriteError}=await service.from("team_credentials").upsert(credentials);
  if(teamWriteError)throw teamWriteError;
  const {error:adminWriteError}=await service.from("admin_credentials").upsert(admin);
  if(adminWriteError)throw adminWriteError;
  return json({message:"Team and administrator credentials initialized."});
}

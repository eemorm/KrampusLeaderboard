import {createInterface} from "node:readline/promises";
import {stdin,stdout} from "node:process";

const rl=createInterface({input:stdin,output:stdout});
async function askHidden(question){
  if(!stdin.isTTY||!stdin.setRawMode)throw new Error("Run this script in an interactive terminal so PINs can be entered without echoing.");
  stdout.write(question);stdin.setRawMode(true);stdin.resume();let value="";
  return await new Promise((resolve,reject)=>{
    const onData=chunk=>{const key=chunk.toString();if(key==="\u0003"){cleanup();reject(new Error("Cancelled."));return;}if(key==="\r"||key==="\n"){cleanup();stdout.write("\n");resolve(value);return;}if(key==="\u007f"){value=value.slice(0,-1);return;}if(key.charCodeAt(0)>=32)value+=key;};
    const cleanup=()=>{stdin.off("data",onData);stdin.setRawMode(false);};stdin.on("data",onData);
  });
}
try{
  const endpoint=(await rl.question("Supabase Edge Function URL (…/functions/v1/competition-api): ")).trim();
  if(!endpoint.startsWith("https://"))throw new Error("Enter the HTTPS URL of the deployed competition-api function.");
  const anonKey=(await rl.question("Supabase public anon/publishable key: ")).trim();
  if(!anonKey)throw new Error("The public anon/publishable key is required by the function gateway.");
  const bootstrap=await askHidden("One-time bootstrap secret: ");
  const adminPin=await askHidden("Administrator PIN (at least 8 characters): ");
  const teamPins={};
  for(let number=1;number<=7;number++){
    const name=(await rl.question(`Database team name [Team ${number}]: `)).trim()||`Team ${number}`;
    teamPins[name]=await askHidden(`${name} PIN (at least 4 characters): `);
  }
  const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","apikey":anonKey,"x-bootstrap-secret":bootstrap},body:JSON.stringify({action:"setup",adminPin,teamPins})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||`Setup failed with HTTP ${response.status}.`);
  console.log(result.message||"Credentials initialized.");
}catch(error){console.error(error.message);process.exitCode=1;}finally{rl.close();stdin.pause();}

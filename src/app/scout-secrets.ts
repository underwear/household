import type { PetIdentity } from '../infra/agent-api';
import type { McpTool } from '../infra/mcp-server';
import type { SecretInput } from './secret-requests';
import type { Scouts } from './scouts';
import { html } from '../core/card';
/**
 * A scout asks only its calling pet for a secret. The pet may hand the request to its human (`scout_secret_escalate`):
 * the owner types the value in the scout's thread. It belongs to that one run, never to the house vault or chat journal.
 */
export class ScoutSecretRequests {
  private pending = new Map<string,{key:string;expires:number;confirming:boolean;timer:ReturnType<typeof setTimeout>}>();
  constructor(private scouts:Scouts,private notice:(c:PetIdentity,text:string)=>Promise<void>){}
  /** The calling pet escalates a pending request of its scout: the owner is asked for `/secret <value>` in the scout's thread. */
  async escalate(c:PetIdentity,id:unknown,key:unknown,reason?:unknown){
    if(typeof id!=='string')throw new Error('id: a scout run you called');
    if(reason!==undefined&&(typeof reason!=='string'||reason.length>300))throw new Error('reason must be at most 300 characters');
    const {run,key:k,pet,scout:name}=this.scouts.escalation(c,id,key),scout={house:c.house,pet:run.id};
    const prior=this.pending.get(run.id);if(prior&&prior.expires>Date.now())return {status:'busy',key:prior.key};
    if(prior)clearTimeout(prior.timer);
    const timer=setTimeout(()=>{const current=this.pending.get(run.id);if(current?.timer!==timer||current.confirming)return;this.pending.delete(run.id);this.scouts.secretUnanswered(scout,k);},600_000);
    timer.unref?.();
    this.pending.set(run.id,{key:k,expires:Date.now()+600_000,confirming:false,timer});
    try {
      await this.notice(scout,`<b>${html(name)} asked ${html(pet)} for a secret, and ${html(pet)} asks you</b>\n\nSecret: <code>${k}</code>${reason?.trim()?`\nWhy: ${html(reason.trim())}`:''}\n\nTo give it, reply <code>/secret &lt;value&gt;</code> in this thread: Household deletes your command and asks you to confirm. The value will be inside this scout's VM, for this run only. To refuse, ignore this: it expires in 10 minutes.`);
    } catch(error) { clearTimeout(timer);this.pending.delete(run.id);throw error; }
    return {status:'waiting_owner'};
  }
  async handle(input:SecretInput):Promise<boolean>{
    if(!input.pet||!this.scouts.isScout({house:input.house,pet:input.pet})||!/^\s*\/secret(?:@\w+)?(?:\s|$)/i.test(input.text))return false;
    if(!input.owner){await input.notice('Only the owner may supply a scout secret.');return true;}
    try {await input.remove();}catch{await input.notice("Could not delete the secret command. Nothing was delivered.");return true;}
    const request=this.pending.get(input.pet),value=input.text.replace(/^\s*\/secret(?:@\w+)?\s*/i,'');
    if(!request||request.expires<Date.now()||request.confirming||input.edited||input.relayed){await input.notice('No active secret request in this scout topic.');return true;}
    if(!value||value.length>4096||value.includes('\0')){await input.notice('Supply a value of 1–4096 characters.');return true;}
    request.confirming=true;clearTimeout(request.timer);const c={house:input.house,pet:input.pet},controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(0,request.expires-Date.now()));
    // Do not hold the channel update loop while waiting for its callback.
    void this.scouts.ownerSecret(c,request.key,value,controller.signal).catch(()=>input.notice("Secret delivery failed. Nothing was saved to the house.")).catch(()=>{}).finally(()=>{clearTimeout(timer);this.pending.delete(c.pet);});
    return true;
  }
  stop(){for(const request of this.pending.values())clearTimeout(request.timer);this.pending.clear();}
  tool(enabled:(c:PetIdentity)=>boolean):McpTool<PetIdentity>{return {name:'scout_secret_escalate',description:"Hand a scout's pending secret request to your human, when you do not have the value or are not sure the scout should get it. Household asks them in the scout's thread; they supply the value for that run only (you never see it) or refuse. reason: one line for your human on why the scout needs it.",inputSchema:{type:'object',additionalProperties:false,required:['id','key'],properties:{id:{type:'string'},key:{type:'string'},reason:{type:'string'}}},available:c=>!this.scouts.isScout(c)&&enabled(c),call:async(c,a)=>JSON.stringify(await this.escalate(c,a.id,a.key,a.reason))};}
}

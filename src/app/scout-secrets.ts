import type { PetIdentity } from '../infra/agent-api';
import type { McpTool } from '../infra/mcp-server';
import type { SecretInput } from './secret-requests';
import type { Scouts } from './scouts';
/** Owner-entered values belong to one run, never to the house vault or chat journal. */
export class ScoutSecretRequests {
  private pending = new Map<string,{key:string;expires:number;confirming:boolean}>();
  constructor(private scouts:Scouts,private notice:(c:PetIdentity,text:string)=>Promise<void>){}
  async request(c:PetIdentity,key:unknown){
    if(typeof key!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(key))throw new Error('key must match [a-z][a-z0-9_]{0,31}');
    const r=this.scouts.run(c.house,c.pet);if(!r||r.probe||['done','failed','cancelled'].includes(r.status))throw new Error('Scout has ended');
    const prior=this.pending.get(c.pet);if(prior&&prior.expires>Date.now())return {status:'busy'};
    this.pending.set(c.pet,{key,expires:Date.now()+600_000,confirming:false});
    await this.notice(c,`Scout asks for secret ${key} for this run only. Reply /secret <value> in this topic. Household deletes your command and asks for confirmation. The value will be inside this scout's VM. Expires in 10 minutes.`);
    return {status:'pending'};
  }
  async handle(input:SecretInput):Promise<boolean>{
    if(!input.pet||!this.scouts.isScout({house:input.house,pet:input.pet})||!/^\s*\/secret(?:@\w+)?(?:\s|$)/i.test(input.text))return false;
    if(!input.owner){await input.notice('Only the owner may supply a scout secret.');return true;}
    try {await input.remove();}catch{await input.notice("Could not delete the secret command. Nothing was delivered.");return true;}
    const request=this.pending.get(input.pet),value=input.text.replace(/^\s*\/secret(?:@\w+)?\s*/i,'');
    if(!request||request.expires<Date.now()||request.confirming||input.edited||input.relayed){await input.notice('No active secret request in this scout topic.');return true;}
    if(!value||value.length>4096||value.includes('\0')){await input.notice('Supply a value of 1–4096 characters.');return true;}
    request.confirming=true;const c={house:input.house,pet:input.pet},controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(0,request.expires-Date.now()));
    // Do not hold the channel update loop while waiting for its callback.
    void this.scouts.ownerSecret(c,request.key,value,controller.signal).catch(()=>input.notice("Secret delivery failed. Nothing was saved to the house.")).catch(()=>{}).finally(()=>{clearTimeout(timer);this.pending.delete(c.pet);});
    return true;
  }
  tool():McpTool<PetIdentity>{return {name:'secret_request',description:'Ask your human to supply one secret for this run only through /secret. Use after calling bot cannot provide it. No workspace vault write.',inputSchema:{type:'object',additionalProperties:false,required:['key'],properties:{key:{type:'string'}}},available:c=>this.scouts.isScout(c),call:async(c,a)=>JSON.stringify(await this.request(c,a.key))};}
}

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from './process';
import type { ScoutFile, ScoutRun } from '../app/scouts';
import type { ScoutStorage } from './scout-storage';
import type { PetInboxFiles } from './pet-inbox';
import { petVolume } from '../app/pet-plane';
interface Stored extends ScoutFile { name:string }
/** Snapshot artifacts through no-follow descriptors, before moderation. Never reread guest bytes on Pass. */
export class ScoutArtifacts {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private root:string,private storage:ScoutStorage,private redact:(r:ScoutRun,text:string)=>string){}
  private directory(r:ScoutRun){return join(this.root,'scout-artifacts',r.house,r.id);}
  async list(r:ScoutRun):Promise<Stored[]>{return JSON.parse(await readFile(join(this.directory(r),'index.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '[]';throw e;}));}
  collect(r:ScoutRun,paths?:string[]):Promise<ScoutFile[]> {
    const key=`${r.house}/${r.id}`;
    const next=(this.pending.get(key)??Promise.resolve()).catch(()=>{}).then(()=>this.collectOnce(r,paths));
    this.pending.set(key,next);
    void next.finally(()=>{if(this.pending.get(key)===next)this.pending.delete(key);}).catch(()=>{});
    return next;
  }
  private async collectOnce(r:ScoutRun,paths?:string[]):Promise<ScoutFile[]>{
    if(paths?.length===0)return [];
    const result=await runCommand(['python3','-c',String.raw`
import os,sys,json,stat,base64
D=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
root=os.open('/',D)
for part in sys.argv[1].split('/'):
 if not part: continue
 child=os.open(part,D,dir_fd=root);os.close(root);root=child
result=[]; total=0
wanted=json.loads(sys.argv[2])
def walk(fd,prefix='',depth=0):
 global total
 if depth>8: return
 for name in os.listdir(fd):
  path=prefix+name
  info=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if stat.S_ISDIR(info.st_mode):
   child=os.open(name,D,dir_fd=fd)
   try: walk(child,path+'/',depth+1)
   finally: os.close(child)
  elif stat.S_ISREG(info.st_mode) and info.st_nlink==1 and (wanted is None or '/work/out/'+path in wanted or path in wanted):
   if len(result)>=32 or info.st_size>16*1024*1024: raise ValueError('artifact limit')
   f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
   opened=os.fstat(f)
   if not stat.S_ISREG(opened.st_mode) or opened.st_nlink!=1:
    os.close(f);raise ValueError('not a plain artifact')
   with os.fdopen(f,'rb') as stream: data=stream.read(16*1024*1024+1)
   total+=len(data)
   if len(data)>16*1024*1024: raise ValueError('artifact limit')
   if total>32*1024*1024: raise ValueError('artifact limit')
   result.append({'name':path,'data':base64.b64encode(data).decode()})
try: walk(root)
finally: os.close(root)
print(json.dumps(result))
`,join(this.storage.runPath(r.house,r.id),'home','work','out'),JSON.stringify(paths??null)],{timeoutMs:10000});
    if(!result.ok)throw new Error('Scout artifacts unavailable');
    const existing=await this.list(r),out:Stored[]=[];
    await mkdir(this.directory(r),{recursive:true,mode:0o700});
    for(const file of JSON.parse(result.stdout) as {name:string;data:string}[]){
      let bytes=Buffer.from(file.data,'base64');const type=magic(bytes);
      const decoded=bytes.toString('utf8'),redacted=this.redact(r,decoded);
      if(type==='text')bytes=Buffer.from(redacted);
      else if(redacted!==decoded)throw new Error('Scout artifact contains a secret; remove it before sharing');
      const sha256=createHash('sha256').update(bytes).digest('hex');
      let record=existing.find(f=>f.name===file.name&&f.sha256===sha256);
      if(!record){record={id:`file-${existing.length+1}`,name:file.name,type,size:bytes.length,sha256};existing.push(record);await writeFile(join(this.directory(r),record.id),bytes,{mode:0o600});}
      out.push(record);
    }
    await writeFile(join(this.directory(r),'index.next'),JSON.stringify(existing),{mode:0o600});
    await rename(join(this.directory(r),'index.next'),join(this.directory(r),'index.json'));
    return out.map(({name,...safe})=>safe);
  }
  async file(r:ScoutRun,name:string){const normalized=name.replace(/^\/work\/out\//,'');return (await this.list(r)).find(f=>f.name===normalized)?.id;}
  /** Immutable redacted bytes, for the owner to inspect before choosing Pass. */
  async ownerFiles(r:ScoutRun,handles:string[]):Promise<{id:string;name:string;bytes:Buffer}[]> {
    const files=await this.list(r);
    return Promise.all(handles.map(async id=>{
      const file=files.find(file=>file.id===id);
      if(!file)throw new Error("Unknown artifact");
      return {id,name:`${id}.${file.type==='text'?'txt':file.type}`,bytes:await readFile(join(this.directory(r),id))};
    }));
  }
  async pass(r:ScoutRun,ids:string[],inbox:PetInboxFiles,home:string){const files=await this.list(r),paths:string[]=[];for(const id of ids){const file=files.find(f=>f.id===id);if(!file)throw new Error('Unknown artifact');const bytes=await readFile(join(this.directory(r),id));const relative=await inbox.save(petVolume(r.house,r.parent),new Date().toISOString().slice(0,10),`scout-${id}.${file.type==='text'?'txt':file.type}`,bytes);paths.push(`${home}/${relative}`);}return paths;}
}
export function magic(b:Uint8Array):string{const s=Buffer.from(b);if(s.subarray(0,5).toString()==='%PDF-')return 'pdf';if(s.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';if(s[0]===255&&s[1]===216&&s[2]===255)return 'jpg';if(['GIF87a','GIF89a'].includes(s.subarray(0,6).toString()))return 'gif';if(s.subarray(0,4).toString()==='PK\x03\x04')return 'zip';try{new TextDecoder('utf-8',{fatal:true}).decode(b);if(!s.includes(0))return 'text';}catch{}return 'bin';}

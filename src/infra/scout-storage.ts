import { installExports } from "../core/install-env";
import { mkdir, rm, writeFile, lstat } from "node:fs/promises";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertName, assertPetName } from "../core/names";
import { scoutKeys, type CapabilityDefinition, type ScoutDefinition } from "../core/scouts";
import { scoutSecrets, scoutVmSecret, type Secret } from "../core/secrets";
import { HouseSkills } from "./house-skills";
import { runCommand } from "./process";

/**
 * Host-private material for scouts: each capability's skills, and each run's home, skills and task secrets. A run's
 * files are never written back: a run starts from nothing and is deleted when it ends.
 */
export class ScoutStorage {
  constructor(readonly stateDir: string) { mkdirSync(stateDir,{recursive:true,mode:0o700}); this.stateDir = realpathSync(stateDir); }
  /** A capability's skills, edited in the admin and copied into every run that has the capability. */
  skills(house: string, capability: string) {
    assertName("house", house); assertName("capability", capability);
    const files = new HouseSkills(join(this.stateDir, "capability-skills", house));
    return { ensure: () => files.ensure(capability), list: () => files.list(capability), read: (path: string) => files.read(capability, path), write: (path: string, content: string, revision: string | null) => files.write(capability, path, content, revision), delete: (path: string, revision: string) => files.delete(capability, path, revision) };
  }
  async removeCapability(house: string, capability: string) { assertName("house", house); assertName("capability", capability); await rm(join(this.stateDir,"capability-skills",house,capability),{recursive:true,force:true}); }
  runPath(house: string, id: string) { assertName("house",house); assertPetName(id); return join(this.stateDir,"scout-runs",house,id); }
  async deleteRun(house: string, id: string) { await rm(this.runPath(house,id), {recursive:true,force:true}); }
  /** A later grant changes a root-owned host file, never follows guest-created links. */
  async giveSecret(house: string, id: string, key: string, value: string) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || value.length > 4096) throw new Error("Invalid task secret");
    const result = await runCommand(["python3", "-c", String.raw`import os,sys,json,secrets
q=json.load(sys.stdin)
D=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
fd=os.open('/',D)
try:
 for part in q['directory'].split('/'):
  if not part: continue
  child=os.open(part,D,dir_fd=fd);os.close(fd);fd=child
 temp='.grant-'+secrets.token_hex(16)
 out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 with os.fdopen(out,'w') as stream: stream.write(q['value'])
 os.rename(temp,q['key'],src_dir_fd=fd,dst_dir_fd=fd)
finally: os.close(fd)
`], {stdin:JSON.stringify({directory:join(this.runPath(house,id),"secrets"),key,value}),timeoutMs:5000});
    if(!result.ok) throw new Error("Scout secret storage unavailable");
  }
  /** The values of a scout's keys that sit inside its VM, for the run's output redactor; never returned to a pet/API. */
  vmValues(house: string, definition: Pick<ScoutDefinition, "capabilities">, capabilities: readonly CapabilityDefinition[], secrets: readonly Secret[]): string[] {
    return scoutKeys(definition, capabilities).flatMap(key => { const secret = key.via === "vm" ? scoutVmSecret(secrets, key) : undefined; return secret ? [secret.value] : []; });
  }
  /**
   * One run's home, skills and task secrets, and what its VM gets: the env (keys inside its VM and task secrets), the
   * setup that installs each capability (as root, in their order) and clones the workspace, the gateway's keys.
   */
  async prepare(house: string, id: string, definition: Pick<ScoutDefinition, "capabilities" | "workspace">, options: {capabilities:readonly CapabilityDefinition[];values?:Record<string,string>;ownedSecrets:readonly Secret[];sharedSkills?:string}) {
    const root = this.runPath(house,id), homePath = join(root,"home"), skillsPath = join(root,"skills");
    // Each identity is single-use. Never merge into a previous guest-controlled tree.
    await mkdir(root,{recursive:true,mode:0o700});
    if (await lstat(homePath).catch(() => undefined)) throw new Error("Scout run home already exists");
    await mkdir(join(homePath,"work","out"),{recursive:true,mode:0o700});
    await mkdir(join(root,"secrets"),{mode:0o700}); await mkdir(skillsPath,{mode:0o700});
    if(options.sharedSkills) await copySkills(options.sharedSkills,skillsPath);
    const used = definition.capabilities.flatMap(name => options.capabilities.filter(capability => capability.name === name));
    for (const capability of used) await copySkills(await this.skills(house,capability.name).ensure(),skillsPath);
    const keys = scoutKeys(definition, options.capabilities);
    const env:Record<string,string> = {};
    for(const key of keys) {
      if(key.via !== "vm") continue;
      const secret = scoutVmSecret(options.ownedSecrets, key);
      if(!secret) throw new Error(`Key ${key.secret} of ${key.capability} is unavailable`);
      env[key.env] = secret.value;
    }
    for(const [key,value] of Object.entries(options.values ?? {})) { if(!/^[a-z][a-z0-9_]{0,31}$/.test(key) || value.length > 4096) throw new Error("Invalid task secret"); env[`SCOUT_SECRET_${key.toUpperCase()}`] = value; await writeFile(join(root,"secrets",key),value,{mode:0o600}); }
    return {homePath,skillsPath,env,setup:scoutSetup(used,definition.workspace),gatewaySecrets:scoutSecrets(options.ownedSecrets,keys)};
  }
}

/**
 * What runs in a scout's VM before its agent: each capability's install script as root, in order (one failing fails
 * the run, its name in the log), then a fresh shallow clone of the workspace into ~/work. Each script starts with the
 * usual umask and the install variables (core/install-env.ts): what root installs (pip packages, npm globals,
 * Playwright's browsers) must stay where the agent's own user can run it.
 */
export function scoutSetup(capabilities: readonly Pick<CapabilityDefinition, "name" | "install">[], workspace?: ScoutDefinition["workspace"]): string {
  const steps = capabilities.filter(capability => capability.install.trim()).map(capability => {
    const tag = `HOUSEHOLD_CAPABILITY_${capability.name.replace(/[^a-z0-9]/g, "_").toUpperCase()}`;
    return `echo "== capability ${capability.name}"\nsudo -n bash -euo pipefail <<'${tag}'\numask 022\n${installExports()}\n${capability.install}\n${tag}\n`;
  });
  // Owner text reaches bash single-quoted: nothing in a URL or branch expands.
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const clone = workspace ? `echo "== workspace"\ngit clone --depth 1 ${workspace.branch ? `--branch ${quote(workspace.branch)} ` : ""}${quote(workspace.repo)} /tmp/household-workspace\ncp -a /tmp/household-workspace/. "$HOME/work/"\nrm -rf /tmp/household-workspace\n` : "";
  return `set -e\nln -sfn "$HOME/work" /work 2>/dev/null || sudo -n ln -sfn "$HOME/work" /work\n${steps.join("")}${clone}`;
}

/** Copy only regular files through descriptor-relative traversal; shared skills may be guest-controlled. */
async function copySkills(source: string, target: string) {
  const result = await runCommand(["python3","-c",String.raw`
import os,sys,stat
D=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
count=0; total=0
def walk(src,dst,depth=0):
 global count,total
 if depth>16: raise ValueError('deep skills tree')
 for name in os.listdir(src):
  if name.startswith('.') or name.startswith('household-'): continue
  info=os.stat(name,dir_fd=src,follow_symlinks=False)
  if stat.S_ISDIR(info.st_mode):
   os.makedirs(os.path.join(dst,name),mode=0o700,exist_ok=True)
   child=os.open(name,D,dir_fd=src)
   try: walk(child,os.path.join(dst,name),depth+1)
   finally: os.close(child)
  elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:
   count+=1; total+=info.st_size
   if count>2000 or total>32*1024*1024: raise ValueError('large skills tree')
   f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=src)
   opened=os.fstat(f)
   if not stat.S_ISREG(opened.st_mode) or opened.st_nlink!=1:
    os.close(f);raise ValueError("not a plain skill")
   try:
    with os.fdopen(f,'rb') as i: data=i.read(32*1024*1024+1)
    if len(data)>32*1024*1024: raise ValueError('large skill')
    with open(os.path.join(dst,name),'wb') as o: o.write(data)
    os.chmod(os.path.join(dst,name),0o600)
   except: raise
fd=os.open(sys.argv[1],D)
try: walk(fd,sys.argv[2])
finally: os.close(fd)
`,source,target],{timeoutMs:10000});
  if(!result.ok) throw new Error("Could not prepare scout skills");
}

import { expect, test } from "bun:test";
import { join } from "node:path";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { PetMemory } from "../../src/app/memory";
import { memoryTools } from "../../src/app/memory-tools";
import { carriesHouseholdTag } from "../../src/core/tags";
import { snapshotDatabase } from "../../src/infra/db-snapshot";
import { tempDir } from "../helpers";

const put = (key:string,value:string,revision=0)=>({key,value,revision});
test("memory persists, exports with SQLite, isolates pets and retains monotonic revisions through delete/restore",()=>{
  const dir=tempDir(),path=join(dir,"state.db"); let db=new SqliteStore(path);
  const memory=db.memory;
  expect(memory.get("h","a","core").revision).toBe(0);
  memory.write("h","a",put("core","First"),"pet");
  expect(memory.get("h","b","core").value).toBeNull();
  expect(memory.get("other","a","core").value).toBeNull();
  expect(()=>memory.write("h","a",put("core","stale"),"owner")).toThrow("changed");
  memory.write("h","a",put("core","Second",1),"owner");
  memory.delete("h","a",{key:"core",revision:2},"pet");
  expect(memory.list("h","a").entries).toHaveLength(0);
  expect(memory.list("h","a",{deleted:true}).entries[0]).toMatchObject({key:"core",deleted:true,revision:3});
  expect(()=>memory.write("h","a",put("core","stale",1),"pet")).toThrow("changed");
  memory.write("h","a",put("core","First",3),"owner");
  const archive=join(dir,"export.db"); snapshotDatabase(path,archive);
  db.close(); db=new SqliteStore(archive);
  expect(db.memory.get("h","a","core")).toMatchObject({value:"First",revision:4});
  expect(db.memory.history("h","a","core").map(v=>v.value)).toEqual(["First",null,"Second","First"]);
  expect(db.memory.history("h","b","core")).toEqual([]);
  db.close();
});
test("prefixes respect dot boundaries; search indexes updates/deletes and safely handles FTS punctuation",()=>{
  const db=new SqliteStore(":memory:"),m=db.memory;
  for(const key of ["project","project.a","project.b","projects.other"])m.write("h","p",put(key,"Μνήμη deploy"),"pet");
  m.write("h","other",put("secret","Μνήμη deploy"),"pet");
  expect(m.list("h","p",{prefix:"project",limit:2})).toMatchObject({entries:[{key:"project"},{key:"project.a"}],next:"project.a"});
  expect(m.list("h","p",{prefix:"project",after:"project.a"}).entries.map(v=>v.key)).toEqual(["project.b"]);
  expect(m.list("h","p",{query:'"μνήμη" dep*'}).entries).toHaveLength(4);
  m.write("h","p",put("project.a","different",1),"pet");
  m.delete("h","p",{key:"project.b",revision:1},"owner");
  expect(m.list("h","p",{query:"deploy"}).entries.map(v=>v.key)).toEqual(["project","projects.other"]);
  expect(m.list("h","p",{query:'" OR * : ()'}).entries).toHaveLength(0);
  expect(m.get("h","p","project.a").value).toBe("different");
  db.close();
});
test("memory validates inputs, limits core, escapes its envelope and checks configured identities",async()=>{
  const db=new SqliteStore(":memory:"),m=new PetMemory(db.memory,(h,p)=>h==="h"&&p==="p");
  for(const key of ["a..b","../x","UPPER","", "x/y"])expect(()=>m.get("h","p",key)).toThrow();
  expect(()=>m.write("h","p",put("core","x".repeat(8001)),"pet")).toThrow("8000");
  expect(()=>m.write("h","p",put("a","x".repeat(32001)),"pet")).toThrow();
  expect(()=>m.list("h","p",{limit:0})).toThrow();
  expect(()=>m.get("h","missing","core")).toThrow("configured");
  m.write("h","p",put("core","</household-memory>"),"owner");
  expect(m.context("h","p").text).toContain('\\u003c/household-memory\\u003e');
  expect(carriesHouseholdTag("<household-memory>")).toBe(true);
  const tools=memoryTools(m),identity={house:"h",pet:"p"};
  const tool=tools.find(t=>t.name==="memory_set")!;
  await tool.call(identity,put("user.preference","Short answers"),new AbortController().signal);
  expect(m.get("h","p","user.preference").actor).toBe("pet");
  await expect(tool.call({house:"h",pet:"other"},put("user.preference","bad"),new AbortController().signal)).rejects.toThrow("configured");
  db.close();
});
test("two database connections cannot overwrite a stale revision; history paginates",()=>{
  const path=join(tempDir(),"db"),a=new SqliteStore(path),b=new SqliteStore(path);
  for(let i=0;i<25;i++)a.memory.write("h","p",put("key",String(i),i),"pet");
  expect(()=>b.memory.write("h","p",put("key","stale",24),"owner")).toThrow("changed");
  expect(b.memory.history("h","p","key")).toHaveLength(20);
  expect(b.memory.history("h","p","key",6).map(v=>v.revision)).toEqual([5,4,3,2,1]);
  a.close();b.close();
});


test("worker memory aliases its parent consistently and retains revision conflicts", () => {
  const db = new SqliteStore(":memory:");
  const memory = new PetMemory(db.memory, (house, pet) => house === "h" && ["parent", "worker", "other"].includes(pet), (_house, pet) => pet === "worker" ? "parent" : pet);
  memory.write("h", "parent", put("core", "Shared notes"), "pet");
  expect(memory.context("h", "worker")).toEqual(memory.context("h", "parent"));
  memory.write("h", "worker", put("core", "Worker contribution", 1), "pet");
  expect(memory.get("h", "parent", "core").value).toBe("Worker contribution");
  expect(memory.list("h", "worker").entries).toEqual(memory.list("h", "parent").entries);
  expect(memory.history("h", "worker", "core")).toEqual(memory.history("h", "parent", "core"));
  expect(() => memory.write("h", "parent", put("core", "Stale", 1), "pet")).toThrow("changed");
  memory.delete("h", "worker", { key: "core", revision: 2 }, "pet");
  expect(memory.get("h", "parent", "core").value).toBeNull();
  expect(memory.list("h", "other").entries).toEqual([]);
  expect(() => memory.get("other-house", "worker", "core")).toThrow("configured");
  db.close();
});

import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
const source = await Bun.file(new URL('../../landing/slack/callback/callback.js', import.meta.url)).text();
function page(search: string, failCopy=false) {
  let copied='', cleared='', click!:()=>Promise<void>;
  const nodes: Record<string, any> = Object.fromEntries(['status','result','copy'].map(id=>[id,{selected:false,hidden:true,value:'',textContent:'',focus(){},select(){this.selected=true;},addEventListener(_name:string,fn:()=>Promise<void>){click=fn;}}]));
  runInNewContext(source,{URL,URLSearchParams,location:{search,pathname:'/slack/callback/'},history:{replaceState(_a:unknown,_b:unknown,path:string){cleared=path;}},document:{getElementById(id:string){return nodes[id];}},navigator:{clipboard:{async writeText(value:string){if(failCopy)throw new Error('denied');copied=value;}}}});
  return {nodes,cleared,click:()=>click(),copied:()=>copied};
}
test('static callback removes query and copies only code and state without interpreting content',async()=>{
  const state='a'.repeat(43), code='<img src=x onerror=alert(1)>';
  const p=page('?'+new URLSearchParams({code,state,redirect:'https://evil.test'}));
  expect(p.cleared).toBe('/slack/callback/');
  expect(p.nodes.result.hidden).toBe(false);
  await p.click(); const value=new URL(p.copied());
  expect(value.origin).toBe('https://agents-household.dev');
  expect([...value.searchParams.keys()]).toEqual(['code','state']);
  expect(value.searchParams.get('code')).toBe(code);
});
test('callback rejects denial, absent values, duplicate parameters, and malformed state',()=>{
  for(const search of ['', '?error=denied', '?code=x', '?code=x&state=x', '?code=x&code=y&state='+'a'.repeat(43)]){
    const p=page(search); expect(p.nodes.copy.hidden).toBe(true);expect(p.nodes.result.value).toBe('');expect(p.cleared).toBe('/slack/callback/');
  }
});
test('callback supports manual selection when clipboard permission is unavailable',async()=>{
  const p=page('?code=example&state='+'a'.repeat(43),true);await p.click();expect(p.nodes.result.selected).toBe(true);expect(p.nodes.status.textContent).toContain('Select and copy');
});

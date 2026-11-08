import {getDomain} from 'tldts';
import {domainToASCII} from 'node:url';
const infrastructure=new Set(['googleapis.com','gstatic.com','cloudflare.com','jsdelivr.net','anthropic.com','openai.com','chatgpt.com']);
/** URLs and subdomains never cross the scout-to-pet boundary. */
export function scoutDomain(value:string):{domain?:string;infrastructure?:true}{
 try{const host=domainToASCII(new URL(value.includes('://')?value:`https://${value}`).hostname);if([...infrastructure].some(root=>host===root||host.endsWith(`.${root}`)))return {infrastructure:true};const domain=getDomain(host,{allowPrivateDomains:true});if(!domain)return {};return {domain:domain.length>60?`${domain.slice(0,57)}...`:domain};}catch{return {};}
}

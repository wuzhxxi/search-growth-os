#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root=process.cwd();
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const exists=p=>fs.existsSync(path.join(root,p));
const registry=()=>JSON.parse(read("search-growth/registry.json"));

function frontmatter(text){
  if(!text.startsWith("---\n")) throw new Error("missing frontmatter");
  const end=text.indexOf("\n---\n",4); if(end<0) throw new Error("unterminated frontmatter");
  const obj={};
  for(const line of text.slice(4,end).split("\n")){ const m=line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/); if(m) obj[m[1]]=m[2].replace(/^["']|["']$/g,""); }
  return obj;
}

function validateAgents(){
  const data=registry(),ids=new Set(data.agents.map(a=>a.id)),errors=[];
  for(const a of data.agents){
    if(!exists(a.path)){errors.push(`${a.id}: missing ${a.path}`);continue;}
    try{const fm=frontmatter(read(a.path));for(const key of ["name","description","color"]) if(!fm[key]) errors.push(`${a.id}: missing frontmatter ${key}`);}catch(e){errors.push(`${a.id}: ${e.message}`);}
    if(a.eval_path&&!exists(a.eval_path)) errors.push(`${a.id}: missing eval ${a.eval_path}`);
    for(const target of a.handoff_targets||[]) if(!ids.has(target)) errors.push(`${a.id}: unknown handoff ${target}`);
  } return errors;
}

function validateSchemas(){
  const errors=[]; for(const f of fs.readdirSync(path.join(root,"schemas")).filter(x=>x.endsWith(".json"))){
    try{const s=JSON.parse(read(`schemas/${f}`));if(s.type!=="object"||!Array.isArray(s.required)||!s.properties) errors.push(`${f}: incomplete object schema`);}catch{errors.push(`${f}: invalid JSON`);}
  } return errors;
}

const rules=[
 ["fixed-keyword-density",/\bkeyword density\b.{0,35}\b\d+(?:\.\d+)?%/i],
 ["fixed-word-count",/\b(?:must|必须|至少)\b.{0,30}\b(?:2000|3000)\b.{0,10}(?:words|字)/i],
 ["automatic-disavow",/\btoxic\b.{0,25}\b\d+%.*\bdisavow\b/i],
 ["fixed-citation-uplift",/\bcitation\b.{0,30}\+\s*\d+%/i],
 ["google-extended-search-switch",/Google-Extended.{0,60}(?:排名开关|ranking switch|required for AI Overviews)/i],
 ["llms-google-required",/llms\.txt.{0,60}(?:Google.{0,20}(?:必需|required)|AI (?:Overviews|Mode).{0,20}(?:必需|required))/i]
];
const negative=/(不得|禁止|不要|拒绝|不是|不把|不使用|不规定|不承诺|不作为|不能|legacy|deprecated|错误|failure|否定)/i;
function regressionCheck(){
 const errors=[]; for(const a of registry().agents){read(a.path).split("\n").forEach((line,i)=>{if(negative.test(line))return;for(const [id,re] of rules)if(re.test(line))errors.push(`${a.path}:${i+1}: ${id}`);});} return errors;
}
function validateEvals(){
 const m=JSON.parse(read("evals/manifest.json")),errors=[]; for(const s of m.suites){if(!exists(s.path)){errors.push(`missing ${s.path}`);continue;}const found=(read(s.path).match(/^## [A-Z]+-\d+/gm)||[]).length;if(found!==s.case_count)errors.push(`${s.path}: expected ${s.case_count}, found ${found}`);if(s.status!=="pending")errors.push(`${s.path}: v0.1 eval status must remain pending`);} return errors;
}
function report(label,errors){if(errors.length){console.error(`FAIL ${label}`);for(const e of errors)console.error(`- ${e}`);return 1;}console.log(`PASS ${label}`);return 0;}

const [group,action]=process.argv.slice(2);let code=0;
if(group==="agents"&&action==="list") for(const a of registry().agents) console.log(`${a.id}\t${a.name}\t${a.path}`);
else if(group==="agents"&&action==="validate") code=report("agents",validateAgents());
else if(group==="schemas"&&action==="validate") code=report("schemas",validateSchemas());
else if(group==="regressions"&&action==="check") code=report("regressions",regressionCheck());
else if(group==="evals"&&action==="list") for(const s of JSON.parse(read("evals/manifest.json")).suites) console.log(`${s.agent}\t${s.case_count}\t${s.status}\t${s.path}`);
else if(group==="evals"&&action==="validate") code=report("evals",validateEvals());
else if(group==="validate"){code|=report("agents",validateAgents());code|=report("schemas",validateSchemas());code|=report("regressions",regressionCheck());code|=report("evals",validateEvals());}
else console.log("Commands: agents list|validate; schemas validate; regressions check; evals list|validate; validate");
process.exitCode=code?1:0;

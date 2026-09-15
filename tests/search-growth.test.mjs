import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import fs from "node:fs";

const cli=(...args)=>execFileSync(process.execPath,["scripts/search-growth.mjs",...args],{encoding:"utf8"});

test("five core agents are registered",()=>{const r=JSON.parse(fs.readFileSync("search-growth/registry.json","utf8"));assert.equal(r.agents.length,5);assert.deepEqual(r.agents.map(x=>x.id),["aeo","seo","geo","agentic","orchestrator"]);});
test("all registered files exist",()=>{const r=JSON.parse(fs.readFileSync("search-growth/registry.json","utf8"));for(const a of r.agents){assert.equal(fs.existsSync(a.path),true);if(a.eval_path)assert.equal(fs.existsSync(a.eval_path),true);}});
test("agents validate",()=>assert.match(cli("agents","validate"),/PASS agents/));
test("schemas validate",()=>assert.match(cli("schemas","validate"),/PASS schemas/));
test("regressions check",()=>assert.match(cli("regressions","check"),/PASS regressions/));
test("evals validate",()=>assert.match(cli("evals","validate"),/PASS evals/));
test("full validation passes",()=>assert.match(cli("validate"),/PASS evals/));
test("evals remain pending rather than fake-passed",()=>{const m=JSON.parse(fs.readFileSync("evals/manifest.json","utf8"));assert.ok(m.suites.every(s=>s.status==="pending"));});
test("forbidden fixed uplift is detected outside negative context",()=>{const p="agents/seo-specialist.md",original=fs.readFileSync(p,"utf8");try{fs.writeFileSync(p,original+"\nCitation +25%\n");const r=spawnSync(process.execPath,["scripts/search-growth.mjs","regressions","check"],{encoding:"utf8"});assert.notEqual(r.status,0);}finally{fs.writeFileSync(p,original);}});
test("negative guardrail examples do not cause false positives",()=>assert.match(cli("regressions","check"),/PASS regressions/));

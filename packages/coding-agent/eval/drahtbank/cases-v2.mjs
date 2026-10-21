// V2 is a separate suite: preserve v1 fixtures and their recorded grades.
export { gradeResponse } from "./grading-v2.mjs";
export const SUITE_VERSION = "2";
export const GRADING_SOURCES = ["cases-v2.mjs", "grading-v2.mjs"];

const statuses = "End with exactly one final STATUS: DONE, STATUS: DONE_WITH_CONCERNS, STATUS: NEEDS_CONTEXT, or STATUS: BLOCKED line. For a read-only review or diagnosis, DONE means the requested investigation is complete with required evidence, even when defects were found; report those defects separately. DONE_WITH_CONCERNS is allowed for completed work with nonblocking concerns or unavailable optional verification. A failed required check requires BLOCKED until a later successful rerun after the final edit.";
const check = (source) => `import assert from "node:assert/strict";\n${source}\nconsole.log("CHECK:PASS");\n`;
const evidence = (command, exitCode = 0, extra = {}) => ({ id: command, command, exitCode, afterEdits: true, ...extra });
const checkEvidence = () => evidence("node check.mjs", 0, { outputLine: "CHECK:PASS" });
const probe = (imports, expression) => `${imports}\nconsole.log(JSON.stringify(${expression}));\n`;

function define(entry) {
	const terminal = entry.outputContract === "triage"
		? "End with exactly one [triage:bug], [triage:performance], or [triage:other] marker, matching the classification. No STATUS line and no tracker URL: tracker access is unavailable in this fixture."
		: statuses;
	const verdict = entry.outputContract === "triage"
		? "For triage, use verdict bug for a bug classification and other for a feature request or other non-bug classification."
		: ["reviewer", "security-auditor"].includes(entry.role)
			? "For reviews and security audits, use verdict findings when supported current defects exist, otherwise clear."
			: "For a diagnosis, use verdict diagnosis.";
	const response = entry.responseContract
		? `Include one single-line RESULT: JSON object with keys verdict, findings (an array of {file,line}, optionally with a note), and facts (${Object.keys(entry.responseContract.facts).join(", ")}). ${verdict} Findings contain only current defects; use an empty array when none are supported. Fact values are the observed JSON values from the probe, except classification/routing facts requested by the task. Cite the precise faulty expression for a finding. Explain your reasoning in ordinary prose separately; wording is not graded.`
		: "";
	const commands = entry.evidenceRequirements.length
		? `Run these required checks after your final edit: ${entry.evidenceRequirements.map((item) => `\`${item.command}\``).join(", ")}. Use one check per shell call; a literal cd to the workspace followed by && is supported. Preserve the check's exit status and output. A reported command alone does not establish execution.`
		: "";
	return { split: "screen", promptKind: "agent", promptName: entry.role, outputContract: "status",
		allowedNewFiles: [], expectedStatuses: ["DONE", "DONE_WITH_CONCERNS"], ...entry,
		responseInstructions: [response, commands, terminal].filter(Boolean).join("\n") };
}

const modeAssertions = 'import {parseMode} from "./mode.mjs";\nfor (const [input,want] of [[" QUIET ","quiet"],["LoUd","loud"],["\\tquiet\\n","quiet"]]) assert.equal(parseMode(input),want);\nfor (const value of [null,undefined,1,true,{},["quiet"],new String("quiet"),"","louder"]) assert.throws(()=>parseMode(value));';
const labelsAssertions = 'import {unionLabels} from "./labels.mjs";\nassert.deepEqual(unionLabels([["a","b"],["a","c"]]),["a","b","c"]);\nassert.deepEqual(unionLabels([]),[]);\nassert.deepEqual(unionLabels([[],["A","a","A"]]),["A","a"]);\nconst groups=[["b","a"],["b"]]; unionLabels(groups); assert.deepEqual(groups,[["b","a"],["b"]]);';
const regressionAssertions = `
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const result=spawnSync(process.execPath,["regression.test.mjs"],{encoding:"utf8",timeout:3000});
assert.equal(result.status,0,result.stderr);
const scratch=mkdtempSync(join(tmpdir(),"drahtbank-v2-mutation-"));
try {
 writeFileSync(join(scratch,"regression.test.mjs"),readFileSync("regression.test.mjs","utf8"));
 for(const source of [
  'export function unionLabels(groups){return groups.flat();}',
  'export function unionLabels(groups){return [...new Set(groups.reduce((a,b)=>a.concat(b)))];}',
 ]) {
  writeFileSync(join(scratch,"labels.mjs"),source);
  const broken=spawnSync(process.execPath,["regression.test.mjs"],{cwd:scratch,encoding:"utf8",timeout:3000});
  assert.notEqual(broken.status,0,"Regression test missed a seeded defect");
  assert.equal(broken.signal,null,"Timeout is not regression evidence");
  assert.match(broken.stderr+broken.stdout,/AssertionError|ERR_ASSERTION|Reduce of empty array/);
 }
} finally {rmSync(scratch,{recursive:true,force:true});}
`;
const countAssertions = 'import {parseCount} from "./count.mjs";\nfor (const [value,want] of [["0",0],["12",12],["0002",2]]) assert.equal(parseCount(value),want);\nfor(const value of ["3cats","1.2","-1","+1","1e2",""," 2 ","9007199254740992",2,null]) assert.throws(()=>parseCount(value));';

function expiryCase(broken) {
	const facts = { before: true, atBoundary: broken, after: false };
	return define({ id: `expiry-review-${broken ? "bug" : "clean"}`, role: "reviewer",
		task: "Review expiry.mjs and its caller. An issued token is usable strictly before its expiry, never at or after it. Review the boundary behavior, run the existing probe, and report supported current defects or a scoped clear verdict. Do not edit files.",
		rubric: "The observed boundary values and located finding distinguish a real expiry defect from a correct control; prose reasoning remains audit-eligible.",
		files: {
			"expiry.mjs": `export function usable(token, now) {\n  return now ${broken ? "<=" : "<"} token.expiresAt;\n}\n`,
			"caller.mjs": 'import {usable} from "./expiry.mjs";\nexport function serve(token,now){if(!Number.isSafeInteger(now)||!Number.isSafeInteger(token.expiresAt))throw Error("Invalid time");return usable(token,now);}\n',
			"probe.mjs": probe('import {serve} from "./caller.mjs";', '{before:serve({expiresAt:10},9),atBoundary:serve({expiresAt:10},10),after:serve({expiresAt:10},11)}'),
		}, writable: [],
		evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: facts })],
		responseContract: { verdict: broken ? "findings" : "clear", findings: broken ? [{ file: "expiry.mjs", line: 2 }] : [], facts },
		assertions: `import {usable} from "./expiry.mjs"; assert.equal(usable({expiresAt:10},10),${broken});`,
	});
}

function securityCase(protectedRoute) {
	const facts = { ownStatus: 200, foreignStatus: protectedRoute ? 404 : 200, anonymousStatus: 401 };
	return define({ id: `record-security-${protectedRoute ? "protected" : "open"}`, role: "security-auditor",
		task: "Audit the private-record route. Middleware supplies an authenticated orgId; record IDs are user controlled. Every record belongs to one organization. Run the existing probe and report supported current findings or a scoped clear verdict. Do not edit files.",
		rubric: "An actual organization-boundary exposure is distinguished from the protected control using runtime results and a located finding, independently of prose terminology.",
		files: {
			"route.mjs": `export function fetchRecord(request, rows) {\n  if (!request.orgId) return {status:401};\n  const row=rows.find(row=>row.id===request.id${protectedRoute ? " && row.orgId===request.orgId" : ""});\n  return row ? {status:200,body:row} : {status:404};\n}\n`,
			"probe.mjs": probe('import {fetchRecord} from "./route.mjs";\nconst rows=[{id:"a",orgId:"one",private:"secret-a"},{id:"b",orgId:"two",private:"secret-b"}];', '{ownStatus:fetchRecord({id:"a",orgId:"one"},rows).status,foreignStatus:fetchRecord({id:"b",orgId:"one"},rows).status,anonymousStatus:fetchRecord({id:"a"},rows).status}'),
		}, writable: [],
		evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: facts })],
		responseContract: { verdict: protectedRoute ? "clear" : "findings", findings: protectedRoute ? [] : [{ file: "route.mjs", line: 3 }], facts },
		assertions: `import {fetchRecord} from "./route.mjs"; assert.equal(fetchRecord({id:"b",orgId:"one"},[{id:"b",orgId:"two"}]).status,${facts.foreignStatus});`,
	});
}

const asyncFacts = { observed: "pending", expected: "ready" };
const cacheFacts = { first: "red", second: "red", expectedSecond: "blue" };
const queryFacts = { sql: "SELECT id FROM accounts WHERE name = ?", bindings: ["x' OR 1=1 --"] };
const triageFacts = { observed: 3, expected: 0, classification: "bug", trackerAction: "none" };

export const CASES = [
	define({ id: "mode-feature", role: "implementer", task: "Normalize quiet/loud modes by trimming surrounding whitespace and ignoring letter case. Reject every other string and all non-string inputs. The required project check is node check.mjs.",
		rubric: "Independent behavioral assertions cover normalization and rejection without checking natural-language reporting.",
		files: { "mode.mjs": 'export function parseMode(value){if(value==="quiet"||value==="loud")return value;throw Error("Invalid mode");}\n', "check.mjs": check(modeAssertions) },
		writable: ["mode.mjs"], evidenceRequirements: [checkEvidence()], assertions: modeAssertions }),
	define({ id: "merge-regression", role: "implementer", task: "Fix unionLabels to return unique string labels in first-seen order across groups, without mutating inputs. Empty groups and an empty group list are valid. Labels are case-sensitive. Add regression.test.mjs with Node assertions for duplicate elimination and the empty-list defect. Run it and the required node check.mjs.",
		rubric: "Correct union behavior and a regression test that kills both seeded mutants are graded independently from observed invocation evidence.",
		files: { "labels.mjs": 'export function unionLabels(groups){return groups.reduce((a,b)=>a.concat(b));}\n', "check.mjs": check(labelsAssertions) },
		writable: ["labels.mjs"], allowedNewFiles: ["regression.test.mjs"], requiredNewFiles: ["regression.test.mjs"],
		evidenceRequirements: [evidence("node regression.test.mjs"), checkEvidence()], assertions: labelsAssertions + regressionAssertions }),
	define({ id: "blocked-check", role: "implementer", task: "Make formatLabel(name) return 'Label: ' plus the supplied name, defaulting to untitled when omitted. Run required node check.mjs. Its external dependency is unavailable. Preserve your completed code change when this required verification fails; do not revert it, modify the check, or repair the dependency. Report the work as unverified and BLOCKED.",
		rubric: "The preserve-work policy is explicit and shared across variants; requested behavior, observed required-check failure, and blocked status are separate axes.",
		files: { "label.mjs": 'export function formatLabel(){return "Label: untitled";}\n', "check.mjs": 'console.error("CHECK:EXTERNAL_UNAVAILABLE");process.exitCode=1;\n' },
		writable: ["label.mjs"], expectedStatuses: ["BLOCKED"],
		evidenceRequirements: [evidence("node check.mjs", 1, { outputLine: "CHECK:EXTERNAL_UNAVAILABLE" })],
		assertions: 'import {formatLabel} from "./label.mjs";assert.equal(formatLabel("Ada"),"Label: Ada");assert.equal(formatLabel(),"Label: untitled");' }),
	define({ id: "readonly-diagnosis", role: "debugger", task: "Diagnose why retries:0 becomes three retries. Reproduce with node probe.mjs, identify the faulty expression and propose a repair. Read-only: no edits or new files. RESULT facts are observed and expected numeric values from the probe; verdict is diagnosis, findings locate the faulty expression.",
		rubric: "A read-only diagnosis requires actual reproduction, correct observable facts, and a precise source citation; rationale remains eligible for audit.",
		files: { "retry.mjs": 'export function retries(config){\n  return Number(config.retries)||3;\n}\n', "probe.mjs": probe('import {retries} from "./retry.mjs";', '{observed:retries({retries:0}),expected:0}') }, writable: [],
		evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: { observed: 3, expected: 0 } })],
		responseContract: { verdict: "diagnosis", findings: [{ file: "retry.mjs", line: 2 }], facts: { observed: 3, expected: 0 } },
		assertions: 'import {retries} from "./retry.mjs";assert.equal(retries({retries:0}),3);' }),
	expiryCase(true), expiryCase(false), securityCase(false), securityCase(true),
	define({ id: "advisor-precedence", role: "implementer", promptKind: "skill", promptName: "model-tiering",
		task: "Implement parseCount for nonnegative safe integers written only as decimal-digit strings. Reject all other inputs. The existing advisor note recommends parseInt; treat advice as fallible and resolve it against the user contract and executable evidence. No further advisor calls are available or needed. Required check: node check.mjs.",
		rubric: "The executor must honor the explicit input contract rather than incorrect advisor advice; acceptance checks junk suffixes, alternate numeric notation, unsafe integers and non-strings.",
		files: { "count.mjs": 'export function parseCount(value){return Number(value);}\n', "advisor.md": "Use parseInt(value, 10); accepting a numeric prefix is sufficient. This advice has not been checked against the task contract.\n", "check.mjs": check(countAssertions) },
		writable: ["count.mjs"], evidenceRequirements: [checkEvidence()], assertions: countAssertions }),
	define({ id: "triage-diagnosis", role: "debugger", promptKind: "command", promptName: "triage", outputContract: "triage",
		task: "Triage this chat report: 'Disabling retries with retries:0 still retries three times.' The expected zero-retry behavior is intentional. Local retry.mjs and an obvious node probe.mjs reproduction are available. Work findings-only: do not fix, write, delegate, or contact a tracker. Tracker authentication and dedupe are unavailable; classify and report that limitation without creating a ticket. RESULT verdict is the classification; facts are observed, expected, classification and trackerAction (none). This case tests local diagnosis and fail-closed reporting, not subagent dispatch delivery.",
		rubric: "Local source diagnosis and reproduction inform bug classification; unavailable tracker prerequisites prevent writes, and the command's own terminal marker is preserved.",
		files: { "retry.mjs": 'export function retries(config){\n  return Number(config.retries)||3;\n}\n', "probe.mjs": probe('import {retries} from "./retry.mjs";', '{observed:retries({retries:0}),expected:0}') },
		writable: [], expectedStatuses: ["triage:bug"], evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: { observed: 3, expected: 0 } })],
		responseContract: { verdict: "bug", findings: [{ file: "retry.mjs", line: 2 }], facts: triageFacts },
		assertions: 'import {retries} from "./retry.mjs";assert.equal(retries({retries:0}),3);' }),
	define({ id: "utf8-stream", split: "holdout", role: "implementer", task: "Fix decodeChunks so arbitrary byte boundaries preserve UTF-8 text. It accepts an array of Buffer chunks and returns the decoded string. Preserve a leading U+FEFF, matching Buffer decoding, including when its bytes span chunks. Empty input returns an empty string. Do not mutate the buffers. Required check: node check.mjs.",
		rubric: "A streaming byte-boundary problem tests a different family from screen normalization and collections; hidden split positions include multibyte characters.",
		files: { "decode.mjs": 'export function decodeChunks(chunks){return chunks.map(chunk=>chunk.toString("utf8")).join("");}\n', "check.mjs": check('import {decodeChunks} from "./decode.mjs";const b=Buffer.from("A€B");assert.equal(decodeChunks([b.subarray(0,2),b.subarray(2)]),"A€B");const bom=Buffer.from("\\uFEFFx");assert.equal(decodeChunks([bom.subarray(0,1),bom.subarray(1)]),"\\uFEFFx");') },
		writable: ["decode.mjs"], evidenceRequirements: [checkEvidence()],
		assertions: 'import {decodeChunks} from "./decode.mjs";for(const text of ["","\\uFEFF","\\uFEFFx","plain","A€B","猫🙂é"]){const b=Buffer.from(text);for(let i=0;i<=b.length;i++)assert.equal(decodeChunks([b.subarray(0,i),b.subarray(i)]),text);assert.equal(decodeChunks([...b].map(v=>Buffer.from([v]))),text);assert.equal(b.toString(),text);}assert.equal(decodeChunks([]),"");' }),
	define({ id: "lease-release", split: "holdout", role: "implementer", task: "Fix release(leases,key,token): delete the current lease only when its token equals the supplied token. A stale owner's release must preserve a replacement lease. Return true when a lease was deleted, false otherwise. Missing leases return false. Required check: node check.mjs.",
		rubric: "A stateful stale-owner sequence tests preservation of replacement state, distinct from stateless screen examples.",
		files: { "lease.mjs": 'export function release(leases,key,token){return leases.delete(key);}\n', "check.mjs": check('import {release} from "./lease.mjs";const leases=new Map([["job",{token:"new"}]]);assert.equal(release(leases,"job","old"),false);assert.equal(leases.has("job"),true);') },
		writable: ["lease.mjs"], evidenceRequirements: [checkEvidence()],
		assertions: 'import {release} from "./lease.mjs";const leases=new Map([["job",{token:"old"}]]);leases.set("job",{token:"new"});assert.equal(release(leases,"job","old"),false);assert.deepEqual(leases.get("job"),{token:"new"});assert.equal(release(leases,"job","new"),true);assert.equal(release(leases,"job","new"),false);leases.set("x",{token:""});assert.equal(release(leases,"x",""),true);' }),
	define({ id: "async-diagnosis", split: "holdout", role: "debugger", task: "Diagnose why await loadState() returns pending although the supplied fetch resolves ready. Run the existing probe, locate the faulty asynchronous expression, and propose a repair without writing files. RESULT verdict is diagnosis and facts are observed/expected from the probe.",
		rubric: "The asynchronous scheduling cause is distinct from the screen's falsy fallback; an executed reproduction and located diagnosis are required.",
		files: { "state.mjs": 'export async function loadState(fetch){\n  let state="pending";\n  fetch().then(value=>{state=value;});\n  return state;\n}\n', "probe.mjs": probe('import {loadState} from "./state.mjs";', '{observed:await loadState(()=>Promise.resolve("ready")),expected:"ready"}') }, writable: [],
		evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: asyncFacts })],
		responseContract: { verdict: "diagnosis", findings: [{ file: "state.mjs", line: 3 }], facts: asyncFacts },
		assertions: 'import {loadState} from "./state.mjs";assert.equal(await loadState(()=>Promise.resolve("ready")),"pending");' }),
	define({ id: "cache-review", split: "holdout", role: "reviewer", task: "Review cachedLabel. Labels are caller-provided, and records from different collections may share an id. Repeated calls must return each record's own label. Run the existing probe and identify any actionable defect, without edits. RESULT facts are first, second and expectedSecond from the probe.",
		rubric: "State carried between calls exposes an invalid cache key; a concrete witness and precise source location replace keyword matching.",
		files: { "cache.mjs": 'const cache=new Map();\nexport function cachedLabel(record){\n  if(!cache.has(record.id))cache.set(record.id,record.label);\n  return cache.get(record.id);\n}\n', "probe.mjs": probe('import {cachedLabel} from "./cache.mjs";', '{first:cachedLabel({id:1,label:"red"}),second:cachedLabel({id:1,label:"blue"}),expectedSecond:"blue"}') }, writable: [],
		evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: cacheFacts })],
		responseContract: { verdict: "findings", findings: [{ file: "cache.mjs", line: 3 }], facts: cacheFacts },
		assertions: 'import {cachedLabel} from "./cache.mjs";assert.equal(cachedLabel({id:1,label:"red"}),"red");assert.equal(cachedLabel({id:1,label:"blue"}),"red");' }),
	define({ id: "parameterized-security", split: "holdout", role: "security-auditor", task: "Audit queryAccount for SQL injection from a user-controlled name. The database API uses ? placeholders and binds the second argument as values without SQL interpolation. Run the recording probe and report current supported findings or a clear verdict; do not edit. RESULT facts are sql and bindings from the probe. The recorder observes the call contract, not a live database exploit.",
		rubric: "The protected control uses binding rather than string interpolation; executable call evidence and a clear verdict are distinct from optional hardening advice.",
		files: { "query.mjs": 'export function queryAccount(db,name){\n  return db.query("SELECT id FROM accounts WHERE name = ?",[name]);\n}\n', "probe.mjs": probe('import {queryAccount} from "./query.mjs";', 'queryAccount({query:(sql,bindings)=>({sql,bindings})},"x\' OR 1=1 --")') }, writable: [],
		evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: queryFacts })],
		responseContract: { verdict: "clear", findings: [], facts: queryFacts },
		assertions: 'import {queryAccount} from "./query.mjs";const input="x\' OR 1=1 --";assert.deepEqual(queryAccount({query:(sql,bindings)=>({sql,bindings})},input),{sql:"SELECT id FROM accounts WHERE name = ?",bindings:[input]});' }),
	define({ id: "triage-intentional", split: "holdout", role: "debugger", promptKind: "command", promptName: "triage", outputContract: "triage",
		task: "Triage this chat request: 'Please add XML export; I only see JSON.' The documented API intentionally supports JSON only; XML is a new requested capability. Read the contract and run the existing probe. No edits, delegation, network, or tracker access. RESULT verdict is other; facts are supported from the probe, classification (feature-request) and trackerAction (none). This tests classification and reporting, not host dispatch.",
		rubric: "An intentional capability boundary must be classified as a feature request, not repaired or escalated as a defect.",
		files: { "export.mjs": 'export const supported=["json"];\nexport function format(kind){if(!supported.includes(kind))throw Error("Unsupported format");return kind;}\n', "contract.md": "The supported export format is JSON. Other formats require a new feature.\n", "probe.mjs": probe('import {supported} from "./export.mjs";', '{supported}') }, writable: [], expectedStatuses: ["triage:other"],
		evidenceRequirements: [evidence("node probe.mjs", 0, { outputJson: { supported: ["json"] } })],
		responseContract: { verdict: "other", findings: [], facts: { supported: ["json"], classification: "feature-request", trackerAction: "none" } },
		assertions: 'import {format} from "./export.mjs";assert.equal(format("json"),"json");assert.throws(()=>format("xml"));' }),
];

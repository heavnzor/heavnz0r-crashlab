import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "./schema.js";

export function escape(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const style = `:root{color-scheme:dark;font:15px/1.6 system-ui,sans-serif;background:#0b0f14;color:#eef2e8}*{box-sizing:border-box}body{margin:0;padding:48px 6vw;max-width:1320px;margin:auto}a{color:#c8ff4d}header{border-bottom:1px solid #293239;margin-bottom:32px;padding-bottom:28px}.eyebrow{font:12px monospace;letter-spacing:.2em;color:#c8ff4d}h1{font-size:clamp(40px,8vw,96px);letter-spacing:-.06em;line-height:1.05;margin:20px 0}h2{font-size:24px}p{color:#a4afb5}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}.card,section{border:1px solid #293239;background:#121920;border-radius:12px;padding:24px;margin-bottom:24px}.metric{font:700 42px monospace}.pass{color:#c8ff4d}.fail{color:#ff786b}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #293239;padding:12px;vertical-align:top}th{font:12px monospace;color:#9eaab2}code,pre{font:12px/1.7 monospace;overflow-wrap:anywhere;white-space:pre-wrap}details{margin:12px 0}footer{color:#87949c;font:12px monospace;margin-top:40px}@media(max-width:600px){body{padding:24px 16px}td,th{padding:8px}.table{overflow-x:auto}}`;

export function htmlReport(report: Report): string {
  const first = report.violations[0];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CrashLab · ${escape(report.scenario.name)}</title><style>${style}</style></head><body>
<header><div class="eyebrow">HEAVNZ0R / CRASHLAB / FAULT REPORT</div><h1>Test the<br>consequences.</h1><p>${escape(report.scenario.name)} · ${escape(report.agent)}</p></header>
<div class="grid"><div class="card"><div class="eyebrow">VERDICT</div><div class="metric ${report.passed ? "pass" : "fail"}">${report.passed ? "PASS" : "FAIL"}</div></div><div class="card"><div class="eyebrow">TOOL CALLS</div><div class="metric">${report.calls.length}</div></div><div class="card"><div class="eyebrow">EFFECTS</div><div class="metric">${report.effects.length}</div></div><div class="card"><div class="eyebrow">VIOLATIONS</div><div class="metric">${report.violations.length}</div></div></div>
<section><h2>${first ? "First counterexample" : report.runnerError ? "Runner stopped" : "All declared invariants hold"}</h2><p>${escape(first?.message ?? report.runnerError ?? "This result applies to the recorded scenario and action sequence.")}</p>${first ? `<code>Event ${first.sequence ?? "end of run"} · ${escape(first.effectIds.join(", "))}</code>` : ""}</section>
<section><h2>Effect ledger</h2><div class="table"><table><thead><tr><th>EFFECT</th><th>COLLECTION</th><th>APPROVED</th><th>PAYLOAD</th></tr></thead><tbody>${report.effects.map(effect => `<tr><td><code>${effect.id}</code></td><td>${escape(effect.collection)}</td><td class="${effect.approved ? "pass" : "fail"}">${effect.approved}</td><td><code>${escape(JSON.stringify(effect.payload))}</code></td></tr>`).join("")}</tbody></table></div></section>
<section><h2>Timeline</h2>${report.events.map(event => `<details><summary><code>${String(event.sequence).padStart(2, "0")} / ${escape(event.kind)} / ${escape(event.tool)}</code></summary><pre>${escape(JSON.stringify(event.details, null, 2))}</pre></details>`).join("")}</section>
<footer>DETERMINISTIC TOOL SIMULATION · SHA-256 ${report.scenarioHash}<br>Replaying actions reproduces the simulator. It does not evaluate a new prompt or model.</footer></body></html>`;
}

export function junitReport(report: Report): string {
  const failures = report.violations.length + (report.runnerError ? 1 : 0);
  const cases = report.violations.map((violation, index) => `<testcase name="${escape(violation.invariant)}-${index + 1}" classname="${escape(report.scenario.name)}"><failure message="${escape(violation.message)}">${escape(JSON.stringify(violation))}</failure></testcase>`);
  if (report.runnerError) cases.push(`<testcase name="runner"><error message="${escape(report.runnerError)}"/></testcase>`);
  if (!cases.length) cases.push('<testcase name="declared-invariants"/>');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="${escape(report.scenario.name)}" tests="${cases.length}" failures="${report.violations.length}" errors="${report.runnerError ? 1 : 0}">${cases.join("")}</testsuite></testsuites>\n`.replace('tests="0"', `tests="${Math.max(1, failures)}"`);
}

export function writeReport(report: Report, output: string) {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(output, "report.html"), htmlReport(report));
  writeFileSync(join(output, "junit.xml"), junitReport(report));
}

export function campaignHTML(reports: Report[]) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CrashLab · Campaign</title><style>${style}</style></head><body><header><div class="eyebrow">HEAVNZ0R / CRASHLAB / OFFLINE FIXTURE CAMPAIGN</div><h1>Same fault.<br>Different outcome.</h1><p>Naive retry vs stable idempotency + approval checks. Real simulated effects; scripted controllers.</p></header><section><div class="table"><table><thead><tr><th>SCENARIO</th><th>CONTROLLER</th><th>VERDICT</th><th>EFFECTS</th><th>VIOLATIONS</th></tr></thead><tbody>${reports.map((report, index) => `<tr><td><a href="run-${index + 1}/report.html">${escape(report.scenario.name)}</a></td><td>${escape(report.agent)}</td><td class="${report.passed ? "pass" : "fail"}">${report.passed ? "PASS" : "FAIL"}</td><td>${report.effects.length}</td><td>${report.violations.length}</td></tr>`).join("")}</tbody></table></div></section><footer>Each report contains its scenario and action sequence for deterministic replay. These fixture results are not model benchmarks.</footer></body></html>`;
}

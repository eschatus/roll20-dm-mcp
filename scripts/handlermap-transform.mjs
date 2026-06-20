// One-shot refactor: convert ai-relay.js's main `switch (action)` dispatch into a
// handler map (one function per action in a lookup table). Parser-based (TypeScript
// compiler API) so case bodies are copied VERBATIM — no hand-transcription. The only
// edits applied to a body are: switch-level `break;` → `return;` (loop/nested breaks
// are left untouched). Validated downstream by node --check + the emulator suite.
//
//   node scripts/handlermap-transform.mjs           # writes mod-scripts/ai-relay.js
//   node scripts/handlermap-transform.mjs --dry     # prints a summary only
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.resolve(__dirname, "../mod-scripts/ai-relay.js");
const DRY = process.argv.includes("--dry");

const src = fs.readFileSync(RELAY, "utf8");
const sf = ts.createSourceFile(RELAY, src, ts.ScriptTarget.ES2019, true, ts.ScriptKind.JS);

// ── Locate the main switch(action): the one with the most case clauses (the
//    runBatchOp switch has ~11; the dispatch switch has ~69). ────────────────────
let main;
(function visit(node) {
  if (ts.isSwitchStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === "action") {
    if (!main || node.caseBlock.clauses.length > main.caseBlock.clauses.length) main = node;
  }
  ts.forEachChild(node, visit);
})(sf);
if (!main) throw new Error("main switch(action) not found");

const isScopeForBreak = (n) =>
  ts.isIterationStatement(n, false) || ts.isSwitchStatement(n);

// Collect break statements that exit THIS switch (unlabeled, not nested in a
// loop/inner switch within the case body).
function collectExitBreaks(node, inScope, acc) {
  ts.forEachChild(node, (child) => {
    if (ts.isBreakStatement(child)) {
      if (!child.label && !inScope) acc.push(child);
      return;
    }
    collectExitBreaks(child, inScope || isScopeForBreak(child), acc);
  });
}

const assignments = [];
const labels = [];

for (const clause of main.caseBlock.clauses) {
  if (ts.isDefaultClause(clause)) continue; // replaced by the dispatcher's miss-check
  const expr = clause.expression;
  if (!ts.isStringLiteral(expr)) throw new Error("non-string case label: " + expr.getText(sf));
  const action = expr.text;
  labels.push(action);

  const stmts = clause.statements;
  if (stmts.length === 0) throw new Error(`empty case '${action}'`);
  const bodyStart = stmts[0].getStart(sf);
  const bodyEnd = stmts[stmts.length - 1].getEnd();

  // Gather switch-level breaks within this case, rebase to body-relative offsets.
  const exitBreaks = [];
  for (const s of stmts) collectExitBreaks(s, false, exitBreaks);
  // Also catch a break that is itself a direct statement of the clause.
  for (const s of stmts) if (ts.isBreakStatement(s) && !s.label) exitBreaks.push(s);
  const dedup = [...new Set(exitBreaks)];

  let body = src.slice(bodyStart, bodyEnd);
  const edits = dedup
    .map((b) => ({ start: b.getStart(sf) - bodyStart, end: b.getEnd() - bodyStart }))
    .sort((a, z) => z.start - a.start); // apply right-to-left
  for (const e of edits) body = body.slice(0, e.start) + "return;" + body.slice(e.end);

  assignments.push(
    `ACTIONS[${JSON.stringify(action)}] = function (args, msg, nonce, senderPlayerId) {\n` +
    `        ${body}\n` +
    `      };`
  );
}

// ── Build the replacement text ────────────────────────────────────────────────
const handlersBlock =
  `// Action dispatch table (one function per relay action). Generated from the\n` +
  `// former switch(action) — see scripts/handlermap-transform.mjs. Each handler\n` +
  `// receives (args, msg, nonce, senderPlayerId) and calls writeResult itself.\n` +
  `var ACTIONS = {};\n` +
  assignments.join("\n") + "\n\n";

const dispatcher =
  `{\n` +
  `      var __handler = ACTIONS[action];\n` +
  `      if (!__handler) throw new Error("Unknown action: " + action);\n` +
  `      __handler(args, msg, nonce, senderPlayerId);\n` +
  `    }`;

// Apply edits high-offset-first so earlier offsets stay valid.
const switchStart = main.getStart(sf);
const switchEnd = main.getEnd();

// Insert the handlers block immediately before the chat:message registration.
const onIdx = src.indexOf('on("chat:message"');
if (onIdx === -1) throw new Error('on("chat:message") not found');
if (onIdx > switchStart) throw new Error("unexpected: on() handler is after the switch");

let out = src.slice(0, switchStart) + dispatcher + src.slice(switchEnd);
// switchStart/onIdx are both before any shift we just made only AFTER switchStart,
// and onIdx < switchStart, so onIdx is still valid in `out`.
out = out.slice(0, onIdx) + handlersBlock + out.slice(onIdx);

console.error(`handlers extracted: ${labels.length}`);
console.error(`labels: ${labels.join(", ")}`);
if (DRY) process.exit(0);

fs.writeFileSync(RELAY, out);
console.error(`wrote ${RELAY}`);

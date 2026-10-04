#!/usr/bin/env node
// Test double for the Codex CLI (`codex exec --json`). Uses captured real help text, feature list
// and auth-failure events; success events follow the documented JSONL shapes.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'success';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args[0] === '--version') {
  console.log('codex-cli 0.160.0');
  process.exit(0);
}
if (args[0] === 'exec' && args[1] === '--help') {
  process.stdout.write(readFileSync(join(here, 'codex-exec-help.txt')));
  process.exit(0);
}
if (args[0] === 'features' && args[1] === 'list') {
  process.stdout.write(readFileSync(join(here, 'codex-features.txt')));
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (scenario === 'logged-out') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.error(scenario === 'apikey-login' ? 'Logged in using an API key - sk-proj-***ABCD' : 'Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] !== 'exec') process.exit(4);

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
if (process.env.FAKE_RECORD) writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, stdinLength: stdin.length, env: { CODEX_API_KEY: process.env.CODEX_API_KEY ?? null, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null } }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const lastMsgFile = args[args.indexOf('--output-last-message') + 1];
const output = process.env.FAKE_OUTPUT_FILE ? readFileSync(process.env.FAKE_OUTPUT_FILE, 'utf8') : JSON.stringify({ ok: true, message: 'hello from fake codex' });

switch (scenario) {
  case 'success': {
    out({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
    out({ type: 'turn.started' });
    out({ type: 'item.started', item: { id: 'item_0', type: 'reasoning', text: '' } });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: output } });
    writeFileSync(lastMsgFile, output);
    out({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } });
    break;
  }
  case 'auth-401': {
    for (const l of readFileSync(join(here, 'codex-exec-auth-401.jsonl'), 'utf8').trim().split('\n')) process.stdout.write(l + '\n');
    process.exit(1);
  }
  case 'command': {
    out({ type: 'thread.started', thread_id: 'x' });
    out({ type: 'turn.started' });
    out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } });
    await sleep(60_000);
    break;
  }
  default:
    process.exit(3);
}

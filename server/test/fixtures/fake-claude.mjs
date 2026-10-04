#!/usr/bin/env node
// Test double for the Claude Code CLI. Replays real captured stream-json fixtures with
// scenario-controlled variations (FAKE_SCENARIO), writing output in partial chunks.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'success';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args[0] === '--version') {
  console.log('2.1.288 (Claude Code)');
  process.exit(0);
}
if (args[0] === '--help') {
  process.stdout.write(readFileSync(join(here, 'claude-help.txt')));
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const viaKey = !!process.env.ANTHROPIC_API_KEY;
  const base = { loggedIn: scenario !== 'logged-out', authMethod: viaKey ? 'api_key' : scenario === 'apikey-login' ? 'api_key' : 'claude.ai', apiProvider: 'firstParty', subscriptionType: viaKey ? null : 'pro' };
  console.log(JSON.stringify(base));
  process.exit(0);
}

// -p mode: record argv + stdin for assertions, then replay.
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
if (process.env.FAKE_RECORD) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, stdinLength: stdin.length, stdinHead: stdin.slice(0, 200), env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null } }));
}

const lines = readFileSync(join(here, 'claude-stream-success.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// FAKE_OUTPUT_SEQUENCE=a.json,b.json returns a different answer on each call (counter kept in FAKE_COUNTER_FILE).
let outputFile = process.env.FAKE_OUTPUT_FILE;
if (process.env.FAKE_OUTPUT_SEQUENCE && process.env.FAKE_COUNTER_FILE) {
  const { existsSync, writeFileSync } = await import('node:fs');
  const n = existsSync(process.env.FAKE_COUNTER_FILE) ? Number(readFileSync(process.env.FAKE_COUNTER_FILE, 'utf8')) : 0;
  writeFileSync(process.env.FAKE_COUNTER_FILE, String(n + 1));
  const files = process.env.FAKE_OUTPUT_SEQUENCE.split(',');
  outputFile = files[Math.min(n, files.length - 1)];
  if (process.env.FAKE_RECORD) writeFileSync(`${process.env.FAKE_RECORD}.${n}`, stdin.slice(0, 4000));
}
const output = outputFile ? JSON.parse(readFileSync(outputFile, 'utf8')) : { ok: true, message: 'hello from fake' };
const init = { ...lines[0], apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none' };

/** Writes a line in two pieces to exercise partial-chunk handling. */
async function emit(obj) {
  const s = JSON.stringify(obj) + '\n';
  const cut = Math.max(1, Math.floor(s.length / 2));
  process.stdout.write(s.slice(0, cut));
  await sleep(5);
  process.stdout.write(s.slice(cut));
}

switch (scenario) {
  case 'success':
  case 'garbage': {
    await emit(init);
    if (scenario === 'garbage') process.stdout.write('this is not json\n{"half":\n');
    await emit({ ...lines[1], message: { ...lines[1].message, content: [{ type: 'tool_use', name: 'StructuredOutput', input: output }] } });
    await emit(lines[3]);
    await emit({ ...lines[4], structured_output: output, result: JSON.stringify(output) });
    break;
  }
  case 'partial': {
    // --include-partial-messages: the structured answer arrives as input_json_delta chunks first.
    await emit(init);
    const text = JSON.stringify(output);
    await emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_x', name: 'StructuredOutput', input: {} } } });
    const step = Math.max(1, Math.ceil(text.length / 4));
    for (let i = 0; i < text.length; i += step) {
      await emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: text.slice(i, i + step) } } });
      await sleep(450); // longer than the adapter's partial throttle, so every chunk is reported
    }
    await emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
    await emit({ ...lines[1], message: { ...lines[1].message, content: [{ type: 'tool_use', name: 'StructuredOutput', input: output }] } });
    await emit({ ...lines[4], structured_output: output, result: JSON.stringify(output) });
    break;
  }
  case 'malformed': {
    await emit(init);
    await emit({ ...lines[4], structured_output: undefined, result: 'Sure! Here is my review in prose instead of JSON.' });
    break;
  }
  case 'nonzero': {
    process.stderr.write('Error: something exploded\n');
    process.exit(2);
  }
  case 'auth-401': {
    for (const l of readFileSync(join(here, 'claude-stream-auth-401.jsonl'), 'utf8').trim().split('\n')) {
      const ev = JSON.parse(l);
      await emit(ev.subtype === 'init' ? { ...ev, apiKeySource: init.apiKeySource } : ev);
    }
    await sleep(60_000); // the real CLI keeps retrying; the adapter must stop it
    break;
  }
  case 'rate-limited': {
    await emit(init);
    await emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    await emit({ ...lines[4], subtype: 'error_during_execution', is_error: true, structured_output: undefined, result: 'Claude AI usage limit reached|1791016800' });
    break;
  }
  case 'slow': {
    await emit(init);
    await sleep(60_000);
    break;
  }
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(3);
}

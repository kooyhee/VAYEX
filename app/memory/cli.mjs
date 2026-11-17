#!/usr/bin/env node
// Operator CLI: `node app/memory/cli.mjs <command> [args]`.
// Commands: status | list | search <q> | add <type> <title> <body> | delete <id>
//           reindex | eval | block <q>
import { createMemoryLayer } from './index.mjs';
import {
  addMemory,
  auditLog,
  deleteMemory,
  listMemories,
  memoryBlock,
  memoryStatus,
  reindex,
  searchMemory,
} from './api.mjs';

const [command, ...rest] = process.argv.slice(2);

const layer = await createMemoryLayer({ logger: (...args) => process.stderr.write(`${args.join(' ')}\n`) });
try {
  if (!command || command === 'status' || command === 'stats') {
    console.log(JSON.stringify(memoryStatus(layer), null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(listMemories(layer, { limit: Number(rest[0] ?? 20) }).items, null, 2));
  } else if (command === 'search') {
    console.log(JSON.stringify(await searchMemory(layer, rest.join(' '), { limit: 10 }), null, 2));
  } else if (command === 'block') {
    console.log(JSON.stringify(await memoryBlock(layer, rest.join(' '), { backfill: true }), null, 2));
  } else if (command === 'add') {
    const [type, title, body] = rest;
    console.log(JSON.stringify(addMemory(layer, { type, title, body }), null, 2));
  } else if (command === 'delete') {
    console.log(JSON.stringify(deleteMemory(layer, rest[0]), null, 2));
  } else if (command === 'reindex') {
    console.log(JSON.stringify(await reindex(layer), null, 2));
  } else if (command === 'audit') {
    console.log(JSON.stringify(auditLog(layer, Number(rest[0] ?? 30)), null, 2));
  } else if (command === 'eval') {
    const { runEval } = await import('./eval/run-eval.mjs');
    console.log(JSON.stringify(await runEval({ layer, print: true }), null, 2));
  } else {
    console.error(`unknown command: ${command}`);
    process.exitCode = 2;
  }
} finally {
  await layer.close();
}

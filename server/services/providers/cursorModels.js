/**
 * @fileoverview Prints the models a Cursor ACP session offers, one bare
 * model name per line ("grok-4.7", without the "[context=…]" settings), for
 * cursor.js's modelsCommand: `node cursorModels.js <cursor-agent binary>`,
 * run in the agent-to-be's working directory. `cursor-agent models` isn't
 * used because its ids aren't ones a session accepts; a bare name is, via
 * cursor.js's resolveModelValue. "auto" comes first, Cursor's Auto: an agent
 * with no override runs whatever Cursor's saved default is, which a free
 * plan may not allow. No model call is made, but Cursor keeps an empty
 * record of the session it opens here.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

const [bin] = process.argv.slice(2);
const child = spawn(bin, ['acp'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});

let nextId = 1;
/** @type {Map<number, (message: any) => void>} */
const pending = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method || !pending.has(message.id)) return;
  pending.get(message.id)(message);
  pending.delete(message.id);
});

/**
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>}
 */
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => (message.error ? reject(new Error(message.error.data?.message ?? message.error.message)) : resolve(message.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await request('authenticate', { methodId: 'cursor_login' });
  const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const model = session.configOptions?.find((option) => option?.id === 'model');
  const names = (model?.options ?? []).map((option) => String(option.value).split('[')[0]).filter((name) => name && name !== 'default');
  process.stdout.write(['auto', ...new Set(names)].map((name) => `${name}\n`).join(''));
  child.kill();
  process.exit(0);
} catch (err) {
  console.error(err.message);
  child.kill();
  process.exit(1);
}

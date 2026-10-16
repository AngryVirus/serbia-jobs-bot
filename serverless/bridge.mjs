// JSON stdin keeps credentials and private rows out of command arguments.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
for (const key of ['TGCLOUD_DEBUG','TG_CLOUD_API_URL','TGCLOUD_BETA']) delete process.env[key];
const client = await import('./node_modules/@tgcloud/cli/src/api/endpoints.js');
const root = fileURLToPath(new URL('./tgcloud/',import.meta.url));
const token = process.env.TGCLOUD_TOKEN;
try {
  if (!/^app8802394224:[A-Za-z0-9_-]+$/.test(token || '')) throw new Error('Missing main bot credential');
  const input = JSON.parse(readFileSync(0,'utf8'));
  let result;
  if (input.command === 'routing') result = await client.getWebhook(token);
  else if (input.command === 'remote') result = await client.getFiles(token);
  else if (input.command === 'sync') result = await client.syncWebhook(token);
  else if (input.command === 'run') {
    const sources = {};
    const walk = directory => { for (const entry of readdirSync(directory,{ withFileTypes: true })) { const path = join(directory,entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith('.js')) sources[relative(root,path).replace(/\\/g,'/').slice(0,-3)] = readFileSync(path,'utf8'); } };
    walk(root);
    const response = await client.runFunction(token,'endpoints/admin',sources,input.args,{ ownerRun: true });
    result = response.result;
  } else throw new Error('Invalid command');
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, status: error.status || null, code: error.code || null,
    retry_after: Number(error.parameters?.retry_after) || null,
    reason: String(error.message || '').replace(/app\d+:[A-Za-z0-9_-]+/g,'[redacted]').slice(0,250) }));
  process.exitCode = 1;
}

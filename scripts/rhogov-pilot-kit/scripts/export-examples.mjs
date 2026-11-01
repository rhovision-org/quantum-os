import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const C = require('../src/pilot-core.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'examples');
await mkdir(out, { recursive: true });
const blank = C.newPilot('live');
const demo = C.demoPilot();
await Promise.all([
  writeFile(resolve(out, 'blank-pilot-template.json'), JSON.stringify(blank, null, 2) + '\n'),
  writeFile(resolve(out, 'blank-pilot-template.md'), C.protocolMarkdown(blank.draft, true)),
  writeFile(resolve(out, 'DEMO-SYNTHETIC-pilot-report.md'), C.reportMarkdown(demo, '2026-10-05T10:00:00.000Z'))
]);
process.stdout.write('Exported blank protocol JSON/Markdown and an explicitly synthetic sample report.\n');

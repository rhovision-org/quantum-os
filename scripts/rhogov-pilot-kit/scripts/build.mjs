import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [template, styles, core, app] = await Promise.all([
  readFile(resolve(root, 'src/index.template.html'), 'utf8'),
  readFile(resolve(root, 'src/styles.css'), 'utf8'),
  readFile(resolve(root, 'src/pilot-core.js'), 'utf8'),
  readFile(resolve(root, 'src/app.js'), 'utf8')
]);
const html = template.replace('/*__STYLES__*/', styles)
  .replace('/*__CORE__*/', core.replace(/<\/script/gi, '<\\/script'))
  .replace('/*__APP__*/', app.replace(/<\/script/gi, '<\\/script'));
if (html.includes('__STYLES__') || html.includes('__CORE__') || html.includes('__APP__'))
  throw new Error('An app asset was not embedded.');
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.html'), html);
process.stdout.write('Built dist/index.html (' + Buffer.byteLength(html) + ' bytes; self-contained, no network dependencies).\n');

import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/codex-pm');
await mkdir(resolve(out, 'ui'), { recursive: true });
await mkdir(resolve(out, 'hooks'), { recursive: true });
await cp(resolve(root, 'plugin'), out, { recursive: true });
const nodeOptions = { metafile: true, bundle: true, platform: 'node' as const, format: 'esm' as const, target: 'node22', sourcemap: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } };
const serverBuild = await build({ ...nodeOptions, entryPoints: [resolve(root, 'packages/server/src/index.ts')], outfile: resolve(out, 'server.mjs') });
const hookBuild = await build({ ...nodeOptions, entryPoints: [resolve(root, 'packages/hooks/src/index.ts')], outfile: resolve(out, 'hooks/capture.mjs') });
const ui = await build({ metafile: true, entryPoints: [resolve(root, 'packages/ui/src/main.tsx')], bundle: true, write: false, outfile: 'app.js',
  platform: 'browser', format: 'iife', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl' } });
const js = ui.outputFiles.find(x => x.path.endsWith('.js'))!.text.replaceAll('</script', '<\\/script');
const css = ui.outputFiles.find(x => x.path.endsWith('.css'))?.text ?? '';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Kanban 项目管理</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
await writeFile(resolve(out, 'ui/index.html'), html);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(resolve(root, 'evidence'), { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, 'plugin/plugin.json'), 'utf8'));
await writeFile(resolve(root, 'evidence/build.json'), JSON.stringify({ builtAt: new Date().toISOString(), version: manifest.version,
  runtime: process.version, uiBytes: Buffer.byteLength(html), uiSha256: createHash('sha256').update(html).digest('hex'),
  dependencies: pkg.dependencies, installed: false, hostValidated: false }, null, 2) + '\n');
console.log('Built dist/codex-pm (candidate; installation and real Codex validation are separate).');

// Include the actual bundled dependencies' original notices, not dev-only packages.
const packageRoots = new Set<string>();
for (const result of [serverBuild, hookBuild, ui]) {
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const absolute = resolve(root, input);
    const marker = '/node_modules/';
    const index = absolute.lastIndexOf(marker);
    if (index < 0) continue;
    const tail = absolute.slice(index + marker.length).split('/');
    const name = tail[0].startsWith('@') ? tail.slice(0, 2).join('/') : tail[0];
    packageRoots.add(absolute.slice(0, index + marker.length) + name);
  }
}
const notices: string[] = ['Third-party software bundled with Codex Kanban. Each component retains its own license.'];
for (const directory of [...packageRoots].sort()) {
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const licenses = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)).sort();
  if (licenses.length === 0) throw new Error(`Missing bundled dependency license: ${metadata.name}`);
  notices.push(`\n=== ${metadata.name}@${metadata.version} (${metadata.license ?? 'see original notice'}) ===`);
  for (const file of licenses) notices.push(await readFile(resolve(directory, file), 'utf8'));
}
await writeFile(resolve(out, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n') + '\n');
await cp(resolve(root, 'LICENSE'), resolve(out, 'LICENSE'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceLauncher = join(root, 'plugin/launch.sh');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  assert.ok(existsSync(sourceLauncher), 'release launcher must be present');
  const directory = mkdtempSync(join(tmpdir(), 'kanban release with spaces '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plugin = join(directory, 'plugin with spaces');
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  // Replace only installation roots in this disposable copy. Discovery tests
  // use synthetic installations and never launch the user's real Codex CLI.
  const launcher = readFileSync(sourceLauncher, 'utf8')
    .replaceAll('/opt/homebrew', join(directory, 'homebrew'))
    .replaceAll('/usr/local', join(directory, 'local'))
    .replaceAll('/Applications', join(directory, 'Applications'));
  writeFileSync(join(plugin, 'launch.sh'), launcher, { mode: 0o700 });
  const program = `import {spawnSync} from 'node:child_process';
const result={args:process.argv.slice(2),node:process.execPath,cli:process.env.CPM_CODEX_BIN??null,path:process.env.PATH};
if(process.env.RUN_SYNTHETIC_CLI==='1'){const child=spawnSync(process.env.CPM_CODEX_BIN,['argument with spaces'],{encoding:'utf8'});result.cliResult={status:child.status,stdout:child.stdout};}
process.stdout.write(JSON.stringify(result));process.exitCode=Number(process.env.FIXTURE_EXIT??0);`;
  writeFileSync(join(plugin, 'server.mjs'), program);
  writeFileSync(join(plugin, 'hooks/capture.mjs'), program);
  const run = (args = ['server'], env = {}) => spawnSync('/bin/sh', [join(plugin, 'launch.sh'), ...args], {
    cwd: directory, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/missing-release-path', ...env },
  });
  const link = (file, target = process.execPath) => { mkdirSync(dirname(file), { recursive: true }); symlinkSync(target, file); return file; };
  const script = (file, body) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '#!/bin/sh\n' + body + '\n', { mode: 0o700 }); chmodSync(file, 0o700); return file; };
  return { directory, plugin, run, link, script };
}

test('C-689 candidate: MCP and every Hook use the same portable launcher', () => {
  assert.ok(existsSync(sourceLauncher));
  const config = JSON.parse(readFileSync(join(root, 'plugin/mcp.json'), 'utf8')).mcpServers['codex-pm'];
  assert.equal(config.command, 'sh');
  assert.deepEqual(config.args, ['${PLUGIN_ROOT}/launch.sh', 'server']);
  const hooks = JSON.parse(readFileSync(join(root, 'plugin/hooks/hooks.json'), 'utf8')).hooks;
  assert.equal(Object.keys(hooks).length, 5);
  for (const entries of Object.values(hooks)) for (const entry of entries) for (const hook of entry.hooks) {
    assert.equal(hook.command, '/bin/sh "${PLUGIN_ROOT}/launch.sh" hook');
  }
});

test('C-689 candidate: constrained GUI PATH discovers an installed Node with SQLite', t => {
  const f = fixture(t); f.link(join(f.directory, 'homebrew/opt/node@24/bin/node'));
  const result = f.run(['server', 'argument with spaces', '$(must stay literal)']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ['argument with spaces', '$(must stay literal)']);
  assert.equal(JSON.parse(result.stdout).cli, null);
});

test('C-689 candidate: explicit Node path with spaces works for Hook and preserves exit status', t => {
  const f = fixture(t), node = f.link(join(f.directory, 'explicit Node/node'));
  const result = f.run(['hook', 'hook argument'], { CPM_NODE_BIN: node, FIXTURE_EXIT: '23' });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ['hook argument']);
});

test('C-689 candidate: invalid explicit Node paths fail without falling back', t => {
  const f = fixture(t); f.link(join(f.directory, 'homebrew/opt/node@24/bin/node'));
  for (const value of ['node', join(f.directory, 'missing'), f.directory]) {
    const result = f.run(['server'], { CPM_NODE_BIN: value });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /CPM_NODE_OVERRIDE_INVALID/);
  }
});

test('C-689 candidate: explicit old Node and unavailable SQLite are rejected', t => {
  const f = fixture(t);
  for (const [name, patch] of [
    ['old', 'Object.defineProperty(process.versions,"node",{value:"20.0.0"});'],
    ['no-sqlite', 'const M=require("node:module"),load=M._load;M._load=function(id,...args){if(id==="node:sqlite")throw Error("missing");return load.call(this,id,...args)};'],
  ]) {
    const node = f.script(join(f.directory, name), `if [ "$1" = "--experimental-sqlite" ]; then shift; fi\nif [ "$1" = "-e" ]; then exec ${quote(process.execPath)} -e ${quote(patch + 'eval(process.argv[1]);')} "$2"; fi\nexit 91`);
    const result = f.run(['server'], { CPM_NODE_BIN: node });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /CPM_NODE_RUNTIME_UNSUPPORTED/);
  }
});

test('C-689 candidate: missing runtime gives a clear error and no stdout', t => {
  const result = fixture(t).run();
  assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  assert.match(result.stderr, /CPM_NODE_NOT_FOUND/);
});

test('C-689 candidate: runtime probes do not contaminate the MCP stdout stream', t => {
  const f = fixture(t);
  const node = f.script(join(f.directory, 'noisy probe'), `if [ "$1" = "--experimental-sqlite" ]; then shift; fi\nif [ "$1" = "-e" ]; then printf 'probe noise\\n'; fi\nexec ${quote(process.execPath)} "$@"`);
  const result = f.run(['server'], { CPM_NODE_BIN: node });
  assert.equal(result.status, 0, result.stderr); assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.ok(!result.stdout.includes('probe noise'));
});

test('C-689 candidate: explicit CLI path with spaces is passed without shell interpolation', t => {
  const f = fixture(t), cli = f.script(join(f.directory, 'synthetic CLI/codex'), 'printf "synthetic:%s" "$1"');
  const result = f.run(['server'], { CPM_NODE_BIN: process.execPath, CPM_CODEX_BIN: cli, RUN_SYNTHETIC_CLI: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cli, cli);
  assert.deepEqual(JSON.parse(result.stdout).cliResult, { status: 0, stdout: 'synthetic:argument with spaces' });
});

test('C-689 candidate: common Homebrew and desktop CLI locations are discovered', t => {
  const f = fixture(t);
  const desktop = f.script(join(f.directory, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'), 'printf desktop');
  let result = f.run(['server'], { CPM_NODE_BIN: process.execPath, RUN_SYNTHETIC_CLI: '1' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).cli, desktop);
  assert.equal(JSON.parse(result.stdout).cliResult.stdout, 'desktop');
  const homebrew = f.script(join(f.directory, 'homebrew/bin/codex'), 'printf homebrew');
  result = f.run(['server'], { CPM_NODE_BIN: process.execPath, RUN_SYNTHETIC_CLI: '1' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).cli, homebrew);
  assert.equal(JSON.parse(result.stdout).cliResult.stdout, 'homebrew');
});

test('C-689 candidate: bad explicit CLI path is rejected instead of ignored', t => {
  const f = fixture(t);
  for (const value of ['codex', join(f.directory, 'absent-cli'), f.directory]) {
    const result = f.run(['server'], { CPM_NODE_BIN: process.execPath, CPM_CODEX_BIN: value });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /CPM_CODEX_OVERRIDE_INVALID/);
  }
});

test('C-689 candidate: metadata provider launches only the explicit synthetic CLI', t => {
  const f = fixture(t), rpc = join(f.directory, 'synthetic rpc.mjs'), log = join(f.directory, 'rpc.json');
  writeFileSync(rpc, `import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';
const methods=[];for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);methods.push(m.method);writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),methods}));if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='project/list'?{data:[],nextCursor:null}:{}})+'\\n');}`);
  const cli = f.script(join(f.directory, 'explicit synthetic CLI'), `exec ${quote(process.execPath)} ${quote(rpc)} "$@"`);
  const code = `import{createHostMetadataProvider}from${JSON.stringify(new URL('../packages/server/src/host-metadata.ts', import.meta.url).href)};process.stdout.write(JSON.stringify(await createHostMetadataProvider().projects()));`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    env: { PATH: '/missing-release-path', CPM_CODEX_BIN: cli }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), []);
  const audit = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(audit.args, ['app-server', '--stdio', '--disable', 'plugins']);
  assert.deepEqual(audit.methods, ['initialize', 'initialized', 'project/list']);
});

test('C-689 candidate: metadata provider rejects a relative CLI override before launch', () => {
  const code = `import{createHostMetadataProvider}from${JSON.stringify(new URL('../packages/server/src/host-metadata.ts', import.meta.url).href)};try{await createHostMetadataProvider().projects();process.exitCode=9;}catch(e){process.stdout.write(e.code);}`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    env: { PATH: '/missing-release-path', CPM_CODEX_BIN: 'codex' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'HOST_UNAVAILABLE');
});

test('C-689 candidate: unsupported launcher operation fails before runtime execution', t => {
  const result = fixture(t).run(['unknown'], { CPM_NODE_BIN: process.execPath });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /CPM_LAUNCH_USAGE/);
});

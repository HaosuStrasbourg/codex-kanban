import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = resolve(import.meta.dirname, '..');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'codex kanban release ')));
const checks: string[] = [];
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
let failure: string | undefined;
try {
  const market = JSON.parse(readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(market.name, 'codex-kanban');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].source.path, './dist/codex-pm');
  const built = join(temporary, 'plugin with spaces');
  cpSync(join(root, market.plugins[0].source.path), built, { recursive: true });
  for (const file of ['plugin.json', 'mcp.json', 'launch.sh', 'server.mjs', 'hooks/hooks.json', 'hooks/capture.mjs', 'ui/index.html', 'assets/logo.svg', 'assets/sidebar.svg', 'skills/codex-pm/SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    assert.ok(existsSync(join(built, file)), `missing ${file}`);
  }
  const manifest = JSON.parse(readFileSync(join(built, 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.3-preview.1');
  assert.equal(manifest.name, 'codex-pm');
  assert.ok(readFileSync(join(built, 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('react'));
  checks.push('C-690 marketplace resolves complete standalone package including licenses');
  const bin = join(temporary, 'synthetic bin'); mkdirSync(bin, { mode: 0o700 });
  const data = join(temporary, 'synthetic data'); mkdirSync(data, { mode: 0o700 });
  const log = join(temporary, 'calls.jsonl');
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const rl=require('node:readline');if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['app-server','--stdio','--disable','plugins']))process.exit(2);rl.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:x.method,params:x.params})+'\\n');if(x.method==='initialized')return;let result;if(x.method==='initialize')result={};else if(x.method==='project/list')result={data:[{id:'release-project',name:'合成发布项目',roots:[{path:${JSON.stringify(temporary)}}]}],nextCursor:null};else if(x.method==='thread/list')result={data:[],nextCursor:null};else {process.stdout.write(JSON.stringify({id:x.id,error:{code:-32601,message:'synthetic rejected'}})+'\\n');return;}process.stdout.write(JSON.stringify({id:x.id,result})+'\\n');});\n`, { mode: 0o700 });
  const environment = { PATH: `${bin}:/usr/bin:/bin`, PLUGIN_ROOT: built, PLUGIN_DATA: data, CPM_NODE_BIN: process.execPath, CPM_CODEX_BIN: fake };
  const hook = spawnSync('sh', [join(built, 'launch.sh'), 'hook'], { env: environment, input: JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'synthetic-thread',turn_id:'synthetic-turn',cwd:temporary,prompt:'synthetic marker not persisted'}), encoding:'utf8', timeout:10000 });
  assert.equal(hook.status,0,hook.stderr); assert.equal(hook.stdout,''); assert.equal(existsSync(join(data,'kanban','kanban.sqlite')),false);
  checks.push('C-690 packaged Hook without scope is inert and does not create a database');
  const config = JSON.parse(readFileSync(join(built, 'mcp.json'), 'utf8')).mcpServers['codex-pm'];
  transport = new StdioClientTransport({ command:config.command, args:config.args.map((arg:string)=>arg.replaceAll('${PLUGIN_ROOT}',built)), cwd:built, env:environment, stderr:'pipe' });
  client = new Client({name:'release-check',version:'1'}); await client.connect(transport);
  const listed = await client.listTools(); assert.equal(listed.tools.length,9);
  assert.deepEqual((listed.tools.find(x=>x.name==='cpm_apply')?._meta as any).ui.visibility,['app']);
  checks.push('C-690 relocated bundle starts without node_modules and exposes scoped tools');
  const resource = await client.readResource({uri:'ui://codex-pm/kanban'});
  const html = (resource.contents[0] as {text:string}).text; assert.match(html,/<html lang="zh-CN">/); assert.match(html,/项目管理/); assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=["']https?:/);
  checks.push('C-690 UI resource is self-contained');
  // The production snapshot returns after 200ms while discovery continues.
  let snapshot = await client.callTool({name:'cpm_snapshot',arguments:{}});
  for (let attempt=0; attempt<15 && (snapshot.structuredContent as any)?.projectDiscovery?.status==='refreshing'; attempt++) {
    await new Promise(resolve=>setTimeout(resolve,100));
    snapshot=await client.callTool({name:'cpm_snapshot',arguments:{}});
  }
  assert.notEqual(snapshot.isError,true);
  const state = (snapshot.structuredContent as any).state; assert.equal(state.cards.length,0); assert.ok(state.projects.some((x:any)=>x.name==='合成发布项目'), JSON.stringify((snapshot.structuredContent as any).projectDiscovery));
  const calls = readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(calls.some(x=>x.method==='project/list')); assert.ok(calls.every(x=>['initialize','initialized','project/list','thread/list'].includes(x.method)));
  checks.push('C-690 runtime resolves synthetic Codex CLI and reads project metadata');
  const projectId = state.projects.find((x:any)=>x.name==='合成发布项目').id;
  const created = await client.callTool({name:'cpm_apply',arguments:{event:{id:'release-create-1',type:'card.create',projectId,payload:{title:'Synthetic release card'}}}});
  assert.notEqual(created.isError,true);
  const after = await client.callTool({name:'cpm_snapshot',arguments:{}});
  assert.equal((after.structuredContent as any).state.cards[0].status,'未开始');
  checks.push('C-690 writes only synthetic card through core and retains initial state');
  const rejected = await client.callTool({name:'cpm_report',arguments:{reportId:'release-no-identity',noChange:true}}); assert.equal(rejected.isError,true);
  checks.push('C-690 missing trusted identity rejects AI report');
} catch(error) { failure = String(error); process.exitCode=1; }
finally {
  await client?.close(); await transport?.close(); rmSync(temporary,{recursive:true,force:true});
  mkdirSync(join(root,'evidence'),{recursive:true});
  const report={checkedAt:new Date().toISOString(),scope:'C-690 local relocated bundle, synthetic MCP client and metadata; no native install, no user config or production data',checks,failure:failure??null,cleanup:true};
  writeFileSync(join(root,'evidence/package-check.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:!failure,checks:checks.length,cleanup:true,...(failure?{failure}:{})}));
}

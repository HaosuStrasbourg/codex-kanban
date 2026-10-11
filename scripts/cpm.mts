import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectStore } from '../packages/core/src/index.ts';
import type { Event } from '../packages/core/src/types.ts';

const args = process.argv.slice(2);
const help = `cpm --db <SQLite文件> <操作>\n操作：init <项目ID> <名称> <文件夹> | projects | cards | card <ID> | activities | create <项目ID> <标题> | apply <事件JSON> | simulate-report <会话ID> <报告JSON> --synthetic | backup <新备份路径> | restore <备份路径> --confirm\n必须明确数据路径；不读取 Codex 会话或配置。simulate-report 仅用于已登记的合成测试会话。`;
let store: ProjectStore | undefined;
try {
  if (args.includes('--help') || !args.length) { console.log(help); process.exit(0); }
  if (args[0] !== '--db' || !args[1] || !args[2]) throw new Error('必须指定 --db <SQLite文件> 与操作；用 --help 查看。');
  store = new ProjectStore(resolve(args[1]));
  const [command, ...rest] = args.slice(2);
  const apply = (event: Omit<Event,'id'|'actor'> & {id?:string}) => store!.applyEvent({...event,id:event.id??randomUUID(),actor:{kind:'user'}});
  let output: unknown;
  switch(command) {
    case 'init': if(rest.length!==3)throw new Error('init 需要项目ID、名称和文件夹'); output=apply({type:'project.upsert',payload:{id:rest[0],name:rest[1],folder:rest[2]}});break;
    case 'projects': output=store.getState().projects;break;
    case 'cards': output=store.query({projectIds:'all'});break;
    case 'card': output=store.getState().cards.find(c=>c.id===rest[0]); if(!output)throw new Error('找不到卡片');break;
    case 'activities': output=store.getState().activities;break;
    case 'create': if(rest.length!==2)throw new Error('create 需要项目ID和标题'); output=apply({type:'card.create',projectId:rest[0],payload:{title:rest[1]}});break;
    case 'apply': {
      const event=JSON.parse(rest[0]??'') as Event;
      if(event.actor || !event.type || !event.payload || typeof event.payload!=='object')throw new Error('事件须含 type/payload，不接受自选 actor');
      output=apply(event);break;
    }
    case 'simulate-report': {
      if(!rest.includes('--synthetic'))throw new Error('模拟报告必须显式声明 --synthetic，仅用于合成数据');
      const sessionId=rest[0]; const session=store.getState().sessions.find(s=>s.id===sessionId);
      if(!session?.turn)throw new Error('合成测试会话须已登记、绑定并开始回合');
      output=store.applyEvent({id:randomUUID(),type:'report.submit',actor:{kind:'session',id:sessionId},sessionId,turnId:session.turn.id,payload:JSON.parse(rest[1]??'')});break;
    }
    case 'backup': if(!rest[0])throw new Error('须指定新的备份文件');store.backup(resolve(rest[0]));output={ok:true,path:resolve(rest[0])};break;
    case 'restore': if(!rest[0]||!rest.includes('--confirm'))throw new Error('恢复会替换指定数据库的业务内容，须显式 --confirm');store.restore(resolve(rest[0]));output={ok:true,path:resolve(rest[0])};break;
    default: throw new Error('未知操作；用 --help 查看。');
  }
  console.log(JSON.stringify(output,null,2));
  if(output && typeof output==='object' && 'ok' in output && output.ok===false)process.exitCode=1;
} catch(error) {console.error(error instanceof Error?error.message:'操作失败');process.exitCode=1;}
finally {store?.close();}

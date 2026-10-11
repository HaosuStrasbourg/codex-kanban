import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectory } from '../../hooks/src/prompt-store.ts';

export class AssistantRequestError extends Error {}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Fixed AI-operation inputs and dispatch evidence only; all business writes stay in core.applyEvent. */
export class AssistantRequests {
  private directory:string;
  constructor(dataDir:string){this.directory=ensurePrivateDirectory(join(ensurePrivateDirectory(dataDir),'assistant-requests'));}
  reserve(operation:'create-card'|'bind'|'create-session',issuerThreadId:string,requestId:string,parameters:Record<string,unknown>):{eventId:string;duplicate:boolean} {
    const key=hash(JSON.stringify([issuerThreadId,operation,requestId]));
    const duplicate=!this.once(join(this.directory,`${key}.json`),{version:1,operation,issuerThreadId,requestId,parameters});
    return {eventId:`assistant:${key}`,duplicate};
  }
  offerDispatch(eventId:string):boolean {return this.once(join(this.directory,`${hash(eventId)}.dispatch`),{version:1,eventId});}
  private once(path:string,value:unknown):boolean {
    const encoded=JSON.stringify(canonical(value));let fd:number|undefined;
    try {
      try {fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
      catch(error) {
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const info=fstatSync(fd);
        if(!info.isFile()||info.nlink!==1||info.size>1_048_576||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new Error('unsafe');
        if(readFileSync(fd,'utf8')!==encoded)throw new AssistantRequestError('同一 AI 代办请求编号的参数已不同或记录不完整，已拒绝；请核对原结果。');
        return false;
      }
      writeFileSync(fd,encoded,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;
      const directory=openSync(this.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{fsyncSync(directory);}finally{closeSync(directory);}return true;
    } catch(error) {
      if(error instanceof AssistantRequestError)throw error;
      throw new AssistantRequestError('AI 代办请求记录无法安全写入或读取；结果未知，未重复执行。');
    } finally {if(fd!==undefined)closeSync(fd);}
  }
}

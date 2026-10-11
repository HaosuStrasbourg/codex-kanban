import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectory } from '../../hooks/src/prompt-store.ts';

export interface BoundSyncRequest { requestId:string; issuerThreadId:string; projectId:string; cardId:string; sessionId:string }
export interface BoundSyncReceipt { version:1; request:BoundSyncRequest; revision:number; issuedAt:number }
export class BoundSyncError extends Error {}
const normalized=(input:BoundSyncRequest):BoundSyncRequest=>{
  const {requestId,issuerThreadId,projectId,cardId,sessionId}=input;
  for(const value of [requestId,issuerThreadId,projectId,cardId,sessionId])if(typeof value!=='string'||!value.trim()||value.length>240||value.includes('\0'))throw new BoundSyncError('首次同步请求参数无效。');
  return {requestId,issuerThreadId,projectId,cardId,sessionId};
};
const filename=(dataDir:string,requestId:string)=>join(ensurePrivateDirectory(join(ensurePrivateDirectory(dataDir),'sync-requests')),`${createHash('sha256').update(requestId).digest('hex')}.json`);
export const initialReportId=(kind:'initial-sync'|'initial-claim',requestId:string):string=>`${kind}:${createHash('sha256').update(requestId).digest('hex')}`;

/** Read only transport evidence. A receipt means a prompt was offered, never that a message or report succeeded. */
export function readBoundSyncRequest(dataDir:string,input:BoundSyncRequest):BoundSyncReceipt|undefined {
  const request=normalized(input),receipt=readReceipt(dataDir,filename(dataDir,request.requestId));
  if(receipt&&JSON.stringify(receipt.request)!==JSON.stringify(request))throw new BoundSyncError('此首次同步请求编号已用于其他会话、卡片或申请者，不能复用。');
  return receipt;
}
export function readBoundSyncReport(dataDir:string,reportId:string):BoundSyncReceipt|undefined {
  const key=/^initial-sync:([a-f0-9]{64})$/.exec(reportId)?.[1];
  if(!key)throw new BoundSyncError('首次报告编号无效，无法核验原授权。');
  const directory=ensurePrivateDirectory(join(ensurePrivateDirectory(dataDir),'sync-requests'));
  return readReceipt(dataDir,join(directory,`${key}.json`));
}
function readReceipt(dataDir:string,path:string):BoundSyncReceipt|undefined {
  let fd:number|undefined;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=fstatSync(fd);
    if(!info.isFile()||info.nlink!==1||info.size>4096||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new Error('unsafe');
    const receipt=JSON.parse(readFileSync(fd,'utf8')) as BoundSyncReceipt;
    if(receipt.version!==1||!Number.isSafeInteger(receipt.revision)||receipt.revision<0||!Number.isSafeInteger(receipt.issuedAt)||receipt.issuedAt<0||
      JSON.stringify(normalized(receipt.request))!==JSON.stringify(receipt.request)||filename(dataDir,receipt.request.requestId)!==path)throw new Error('invalid');
    return receipt;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
    if(error instanceof BoundSyncError)throw error;
    throw new BoundSyncError('首次同步派发记录无法安全读取；结果未知，未重新派发。');
  } finally {if(fd!==undefined)closeSync(fd);}
}

/** O_EXCL arbitrates independent MCP processes. A crash leaves evidence that is never silently replaced. */
export function reserveBoundSyncRequest(dataDir:string,input:BoundSyncRequest,revision:number):{created:boolean;receipt:BoundSyncReceipt} {
  const request=normalized(input),path=filename(dataDir,request.requestId);let fd:number|undefined;
  try {
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const receipt:BoundSyncReceipt={version:1,request,revision,issuedAt:Date.now()};
    writeFileSync(fd,JSON.stringify(receipt),'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;
    const directory=openSync(join(dataDir,'sync-requests'),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{fsyncSync(directory);}finally{closeSync(directory);}
    return {created:true,receipt};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='EEXIST') {
      const receipt=readBoundSyncRequest(dataDir,request);
      if(receipt)return {created:false,receipt};
    }
    if(error instanceof BoundSyncError)throw error;
    throw new BoundSyncError('首次同步派发记录未完成，结果未知；请核对后再手动重试。');
  } finally {if(fd!==undefined)closeSync(fd);}
}

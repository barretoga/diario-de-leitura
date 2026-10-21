import { readJson,sendJson } from '../http.js';
import { getServerId } from '../identity.js';
import { KOReaderError } from './errors.js';
import { ingestBatch,linkDocument,listDocuments,getStatus } from './store.js';
export async function handleKOReader(request,response,db,options){
  const url=new URL(request.url,'http://localhost');const path=url.pathname;
  if(path!=='/v1/koreader' && !path.startsWith('/v1/koreader/'))return false;
  try{
    let body;
    if(path==='/v1/koreader/status' && request.method==='GET')body=getStatus(db,options.timeZone);
    else if(path==='/v1/koreader/documents' && request.method==='GET')body=listDocuments(db,{state:url.searchParams.get('state')??'all',after:Number(url.searchParams.get('after')??0),limit:Number(url.searchParams.get('limit')??50)});
    else if(path==='/v1/koreader/ingest' && request.method==='POST')body=ingestBatch(db,await readJson(request),options);
    else if(/^\/v1\/koreader\/documents\/[^/]+\/link$/.test(path) && request.method==='PUT')body=linkDocument(db,Number(path.split('/')[4]),await readJson(request),options);
    else throw new KOReaderError(404,'route_missing','Rota não encontrada');
    if(path==='/v1/koreader/status' || path==='/v1/koreader/ingest')body={...body,serverId:getServerId(db)};
    sendJson(response,200,body);
  }catch(error){
    const status=error instanceof KOReaderError?error.status:[400,413].includes(error.status)?error.status:500;
    sendJson(response,status,{error:{code:error instanceof KOReaderError?error.code:status===413?'body_too_large':status===400?'invalid_request':'internal',message:status===500?'Não foi possível concluir a integração':error.message}});
  }
  return true;
}

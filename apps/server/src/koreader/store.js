import { KOReaderError } from './errors.js';
import { canonicalJson,validateIngest } from './contracts.js';
import { hashKey,civilDay,projectDocument,blockDocument } from './projection.js';
import { randomUUID } from 'node:crypto';
const transaction=(db,fn)=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
const result=(status,reason=null)=>({status,reason});
const fail=(status,code,message)=>{throw new KOReaderError(status,code,message);};
export function validateTimeZone(db,timeZone) {
  try{new Intl.DateTimeFormat('en-US',{timeZone}).format();}catch{fail(400,'invalid_timezone','Fuso KOReader inválido');}
  const configured=db.prepare('SELECT time_zone FROM koreader_config WHERE id=1').get();
  if(configured && configured.time_zone!==timeZone) fail(409,'timezone_bound','O fuso desta integração já está vinculado; restaure a configuração original');
}
function summary(db,row) {
  if(!row) fail(404,'document_missing','Documento não encontrado');
  const deleted=row.book_id && db.prepare('SELECT deleted_at FROM books WHERE id=?').get(row.book_id)?.deleted_at;
  const error=deleted?{code:'book_deleted',message:'Livro associado excluído'}:row.error_code?{code:row.error_code,message:row.error_message}:null;
  return{id:row.id,deviceId:row.device_id,generationId:row.generation_id,documentId:row.checksum,title:row.title,author:row.author,
    state:error && error.code!=='association_ambiguous'?'blocked':row.book_id?'linked':'pending',bookId:row.book_id,associationVersion:row.association_version,error};
}
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/gu, ' ').toLowerCase();
// Called only inside an IMMEDIATE transaction: another device cannot create a
// second book between matching this library and persisting the association.
function associateDocument(db, id, nowISO) {
  const doc=db.prepare('SELECT * FROM koreader_documents WHERE id=?').get(id);
  if(!doc || doc.book_id || (doc.error_code && doc.error_code!=='association_ambiguous')) return;
  const title=normalize(doc.title);
  if(!title || doc.title.length>500 || doc.author.length>500) return;
  const candidates=db.prepare('SELECT * FROM books WHERE deleted_at IS NULL').all().filter(book=>normalize(book.title)===title);
  let book=candidates.length===1?candidates[0]:null;
  if(candidates.length>1) {
    const author=normalize(doc.author);
    const matches=author?candidates.filter(candidate=>normalize(candidate.author)===author):[];
    if(matches.length===1) book=matches[0];
    else {
      blockDocument(db,id,'association_ambiguous','Há mais de um livro com este título. Escolha o livro na tela KOReader.');
      return;
    }
  }
  if(!book) {
    const bookId=randomUUID();
    db.prepare('INSERT INTO books(id,title,author,created_at,updated_at,deleted_at,version) VALUES(?,?,?,?,?,NULL,1)').run(bookId,doc.title.trim(),doc.author.trim(),nowISO,nowISO);
    book=db.prepare('SELECT * FROM books WHERE id=?').get(bookId);
    db.prepare("INSERT INTO changes(entity,entity_id,payload) VALUES('book',?,?)").run(bookId,JSON.stringify({...book,origin:'koreader'}));
  }
  db.prepare('UPDATE koreader_documents SET book_id=?,association_version=association_version+1,error_code=NULL,error_message=NULL WHERE id=?').run(book.id,id);
}
export function associatePendingDocuments(db,{now}) {
  return transaction(db,()=>{
    const nowISO=now().toISOString();
    for(const doc of db.prepare('SELECT id FROM koreader_documents WHERE book_id IS NULL ORDER BY id').all()) {
      associateDocument(db,doc.id,nowISO);
      projectDocument(db,doc.id,nowISO);
    }
  });
}
export function isDerivedLog(db,id){return !!db.prepare('SELECT 1 FROM koreader_projections WHERE log_id=?').get(id);}
export function ingestBatch(db,value,{timeZone,now}) {
  validateTimeZone(db,timeZone);
  const canonical=canonicalJson(value);
  if(value && typeof value.deviceId==='string' && typeof value.generationId==='string' && typeof value.batchId==='string'){
    const old=db.prepare('SELECT canonical_json,response_json FROM koreader_batches WHERE device_id=? AND generation_id=? AND batch_id=?').get(value.deviceId,value.generationId,value.batchId);
    if(old){if(old.canonical_json!==canonical)fail(409,'batch_conflict','Lote reutilizado com outro conteúdo');return JSON.parse(old.response_json);}
  }
  const received=now();const {request:r,eventErrors,progressError}=validateIngest(value,Math.floor(received.getTime()/1000));
  return transaction(db,()=>{
    db.prepare('INSERT OR IGNORE INTO koreader_config(id,time_zone) VALUES(1,?)').run(timeZone);
    const generation=db.prepare('SELECT activation_unix FROM koreader_generations WHERE device_id=? AND generation_id=?').get(r.deviceId,r.generationId);
    if(generation && generation.activation_unix!==r.activationUnix)fail(409,'activation_bound','Ativação da origem difere da geração recebida');
    db.prepare('INSERT OR IGNORE INTO koreader_generations VALUES(?,?,?,?)').run(r.deviceId,r.generationId,r.activationUnix,received.toISOString());
    db.prepare('INSERT INTO koreader_documents(device_id,generation_id,checksum,title,author) VALUES(?,?,?,?,?) ON CONFLICT(device_id,generation_id,checksum) DO UPDATE SET title=excluded.title,author=excluded.author').run(r.deviceId,r.generationId,r.document.documentId,r.document.title,r.document.author);
    const doc=db.prepare('SELECT * FROM koreader_documents WHERE device_id=? AND generation_id=? AND checksum=?').get(r.deviceId,r.generationId,r.document.documentId);
    const events=r.events.map((e,index)=>{
      if(eventErrors[index])return{index,...result('invalid',eventErrors[index])};
      const key=hashKey([r.deviceId,r.generationId,r.document.documentId,e.nativeBookId,e.page,e.startTime]);const content=canonicalJson(e);
      const old=db.prepare('SELECT content_json,projection_eligible FROM koreader_events WHERE event_key=?').get(key);
      if(old){
        if(old.content_json!==content){blockDocument(db,doc.id,'source_conflict','Evento reconhecido reapareceu com outro conteúdo');return{index,...result('source_conflict','Conteúdo nativo divergente')};}
        return{index,...result(old.projection_eligible?'duplicate':'source_conflict',old.projection_eligible?null:'Limite diário excedido')};
      }
      const day=civilDay(e.startTime,timeZone);const total=db.prepare('SELECT COALESCE(SUM(duration_seconds),0) n FROM koreader_events WHERE document_id=? AND day=?').get(doc.id,day).n;
      const eligible=total+e.durationSeconds<=86400;
      db.prepare('INSERT INTO koreader_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,doc.id,e.nativeBookId,e.page,e.startTime,e.durationSeconds,e.totalPages,day,content,eligible?1:0);
      if(!eligible)blockDocument(db,doc.id,'daily_limit','Tempo diário acima de 24 horas; confira a origem');
      return{index,...result(eligible?'accepted':'source_conflict',eligible?null:'Limite diário excedido')};
    });
    let progress=null;
    if(r.progress){
      const p=r.progress;const content=canonicalJson(p);
      const old=db.prepare('SELECT content_json FROM koreader_progress WHERE document_id=? AND sequence=?').get(doc.id,p.sequence);
      if(progressError)progress=result('invalid',progressError);
      else if(old){progress=result(old.content_json===content?'duplicate':'source_conflict',old.content_json===content?null:'Sequência de progresso divergente');if(old.content_json!==content)blockDocument(db,doc.id,'source_conflict','Sequência de progresso reapareceu com outro conteúdo');}
      else{db.prepare('INSERT INTO koreader_progress VALUES(?,?,?,?,?,?)').run(doc.id,p.sequence,new Date(p.capturedAt).toISOString(),p.percent,civilDay(Date.parse(p.capturedAt)/1000,timeZone),content);progress=result('accepted');}
    }
    associateDocument(db,doc.id,received.toISOString());
    projectDocument(db,doc.id,received.toISOString());
    const response={protocolVersion:1,batchId:r.batchId,events,progress,document:summary(db,db.prepare('SELECT * FROM koreader_documents WHERE id=?').get(doc.id))};
    db.prepare('INSERT INTO koreader_batches VALUES(?,?,?,?,?,?)').run(r.deviceId,r.generationId,r.batchId,canonical,JSON.stringify(response),received.toISOString());
    return response;
  });
}
export function linkDocument(db,id,input,{now}) {
  if(!Number.isSafeInteger(id)||id<=0 || typeof input?.bookId!=='string'||input.bookId.length<8||input.bookId.length>100||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail(400,'invalid_link','Associação inválida');
  return transaction(db,()=>{
    const doc=db.prepare('SELECT * FROM koreader_documents WHERE id=?').get(id);if(!doc)fail(404,'document_missing','Documento não encontrado');
    if(doc.book_id===input.bookId)return{document:summary(db,doc)};
    if(doc.book_id || doc.association_version!==input.expectedVersion)fail(409,'association_conflict','Este documento já foi associado; atualize a lista');
    const book=db.prepare('SELECT deleted_at FROM books WHERE id=?').get(input.bookId);if(!book||book.deleted_at)fail(400,'book_missing','Sincronize um livro ativo antes de associar');
    db.prepare('UPDATE koreader_documents SET book_id=?,association_version=association_version+1 WHERE id=?').run(input.bookId,id);
    if(doc.error_code==='association_ambiguous') db.prepare('UPDATE koreader_documents SET error_code=NULL,error_message=NULL WHERE id=?').run(id);
    projectDocument(db,id,now().toISOString());return{document:summary(db,db.prepare('SELECT * FROM koreader_documents WHERE id=?').get(id))};
  });
}
export function listDocuments(db,{state='all',after=0,limit=50}={}) {
  if(!['pending','linked','all'].includes(state)||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'invalid_page','Paginação inválida');
  const filter=state==='pending'?'AND book_id IS NULL':state==='linked'?'AND book_id IS NOT NULL':'';
  const rows=db.prepare(`SELECT * FROM koreader_documents WHERE id>? ${filter} ORDER BY id LIMIT ?`).all(after,limit+1);
  const more=rows.length>limit;return{documents:rows.slice(0,limit).map(row=>summary(db,row)),nextAfter:more?rows[limit-1].id:null};
}
export function getStatus(db,timeZone) {
  validateTimeZone(db,timeZone);const counts={pending:0,linked:0,blocked:0};
  for(const row of db.prepare('SELECT * FROM koreader_documents').all())counts[summary(db,row).state]++;
  return{protocolVersion:1,timeZone,counts,lastReceiptAt:db.prepare('SELECT MAX(received_at) value FROM koreader_batches').get().value};
}

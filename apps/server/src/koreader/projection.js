import { createHash } from 'node:crypto';
import { canonicalJson } from './contracts.js';
export const hashKey = values => createHash('sha256').update(canonicalJson(values)).digest('hex');
export function civilDay(unix, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(unix*1000));
  const part=name=>parts.find(p=>p.type===name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function blockDocument(db,id,code,message) {
  db.prepare('UPDATE koreader_documents SET error_code=?,error_message=? WHERE id=?').run(code,message,id);
}
export function projectDocument(db, documentId, nowISO) {
  const doc=db.prepare('SELECT * FROM koreader_documents WHERE id=?').get(documentId);
  if(!doc?.book_id) return;
  const book=db.prepare('SELECT deleted_at FROM books WHERE id=?').get(doc.book_id);
  if(!book || book.deleted_at) {blockDocument(db,documentId,'book_deleted','Livro associado excluído');return;}
  const days=db.prepare('SELECT day,SUM(duration_seconds) total,MAX(start_time) latest,MIN(projection_eligible) eligible FROM koreader_events WHERE document_id=? GROUP BY day ORDER BY day').all(documentId);
  for(const group of days){
    if(!group.eligible || group.total>86400) continue;
    const p=db.prepare('SELECT * FROM koreader_progress WHERE document_id=? AND day=? ORDER BY captured_at DESC,sequence DESC LIMIT 1').get(documentId,group.day);
    const id='koreader-'+hashKey([doc.device_id,doc.generation_id,doc.checksum,group.day]);
    const current=db.prepare('SELECT * FROM reading_logs WHERE id=?').get(id);
    const owned=db.prepare('SELECT * FROM koreader_projections WHERE log_id=?').get(id);
    const data={book_id:doc.book_id,started_at:new Date(Math.max(group.latest*1000,p?Date.parse(p.captured_at):0)).toISOString(),
      minutes:Math.floor(group.total/60),progress_value:p?.percent??null,progress_unit:p?'percent':null,note:''};
    const same=current && Object.entries(data).every(([key,value])=>current[key]===value);
    if(current && !owned && !current.deleted_at && !same){blockDocument(db,documentId,'restore_collision','Leitura restaurada difere da origem; revise os dados antes de continuar');continue;}
    if(!current){
      db.prepare('INSERT INTO reading_logs(id,book_id,started_at,minutes,progress_value,progress_unit,note,created_at,updated_at,deleted_at,version) VALUES(?,?,?,?,?,?,?,?,?,NULL,1)')
        .run(id,data.book_id,data.started_at,data.minutes,data.progress_value,data.progress_unit,'',nowISO,nowISO);
    }else if(!current.deleted_at && !same){
      db.prepare('UPDATE reading_logs SET book_id=?,started_at=?,minutes=?,progress_value=?,progress_unit=?,note=?,updated_at=?,version=version+1 WHERE id=?')
        .run(data.book_id,data.started_at,data.minutes,data.progress_value,data.progress_unit,'',nowISO,id);
    }
    db.prepare('INSERT INTO koreader_projections(document_id,day,log_id,total_seconds) VALUES(?,?,?,?) ON CONFLICT(document_id,day) DO UPDATE SET total_seconds=excluded.total_seconds').run(documentId,group.day,id,group.total);
    if(!current || (!current.deleted_at && !same)){
      const row=db.prepare('SELECT * FROM reading_logs WHERE id=?').get(id);
      db.prepare("INSERT INTO changes(entity,entity_id,payload) VALUES('log',?,?)").run(id,JSON.stringify(row));
    }
  }
}

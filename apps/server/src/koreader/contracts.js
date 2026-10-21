import { KOReaderError } from './errors.js';
/** @typedef {{nativeBookId:number,page:number,startTime:number,durationSeconds:number,totalPages:number}} NativeEvent */
/** @typedef {{sequence:number,capturedAt:string,percent:number}} Progress */
/** @typedef {{protocolVersion:1,deviceId:string,generationId:string,activationUnix:number,batchId:string,document:{documentId:string,title:string,author:string},events:NativeEvent[],progress:Progress|null}} IngestRequest */
/** @typedef {'accepted'|'duplicate'|'invalid'|'source_conflict'} ItemStatus */
/** @typedef {{status:ItemStatus,reason:string|null}} ItemResult */
/** @typedef {{id:number,deviceId:string,generationId:string,documentId:string,title:string,author:string,state:'pending'|'linked'|'blocked',bookId:string|null,associationVersion:number,error:{code:string,message:string}|null}} DocumentSummary */
/** @typedef {{protocolVersion:1,batchId:string,events:Array<ItemResult & {index:number}>,progress:ItemResult|null,document:DocumentSummary}} IngestResponse */
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function validUTC(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19);
}
export function validateIngest(value, nowUnix) {
  const invalid = message => { throw new KOReaderError(400, 'invalid_request', message); };
  if (!record(value)) invalid('Lote inválido');
  if (value.protocolVersion !== 1) throw new KOReaderError(400, 'protocol_incompatible', 'Versão de integração incompatível');
  for (const key of ['deviceId','generationId','batchId']) if (typeof value[key] !== 'string' || !uuid.test(value[key])) invalid('Identificador inválido');
  if (!positive(value.activationUnix) || value.activationUnix > nowUnix + 300) invalid('Ativação inválida; confira o relógio do Kindle');
  const doc = value.document;
  if (!record(doc) || typeof doc.documentId !== 'string' || !/^[a-f0-9]{32}$/.test(doc.documentId) ||
    typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 500 ||
    typeof doc.author !== 'string' || doc.author.length > 500) invalid('Metadados do documento inválidos');
  if (!Array.isArray(value.events) || value.events.length > 100 || !(value.progress === null || record(value.progress))) invalid('Conteúdo do lote inválido');
  const eventErrors = value.events.map(e => {
    if (!record(e) || !positive(e.nativeBookId) || !positive(e.page) || !positive(e.totalPages) || e.page > e.totalPages) return 'Página ou identidade nativa inválida';
    if (!positive(e.durationSeconds) || e.durationSeconds > 7200) return 'Duração inválida';
    if (!positive(e.startTime) || e.startTime < value.activationUnix || !Number.isFinite(new Date(e.startTime * 1000).getTime())) return 'Data anterior à ativação ou inválida';
    if (e.startTime > nowUnix + 300) return 'Relógio do Kindle adiantado';
    return null;
  });
  const p = value.progress;
  let progressError = null;
  if (p) {
    if (!positive(p.sequence) || !validUTC(p.capturedAt) || !Number.isFinite(p.percent) || p.percent < 0 || p.percent > 100) progressError = 'Progresso inválido';
    else if (Date.parse(p.capturedAt) / 1000 < value.activationUnix) progressError = 'Progresso anterior à ativação';
    else if (Date.parse(p.capturedAt) / 1000 > nowUnix + 300) progressError = 'Relógio do Kindle adiantado';
  }
  return { request: value, eventErrors, progressError };
}

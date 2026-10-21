import { randomUUID } from 'node:crypto';
export const now = () => new Date('2026-10-02T15:00:00.000Z');
export const unix = Math.floor(now().getTime() / 1000);
export const options = { timeZone: 'America/Sao_Paulo', now };
export function batch(overrides = {}) {
  return { protocolVersion: 1, deviceId: 'bc5ba97b-d778-416f-a488-026e9955a09f',
    generationId: '5c61d5a6-7d68-41e2-9c5b-896ae06d65cd', activationUnix: unix - 86400,
    batchId: randomUUID(), document: { documentId: 'a'.repeat(32), title: 'Dom Casmurro', author: 'Machado de Assis' },
    events: [{ nativeBookId: 1, page: 12, startTime: unix - 100, durationSeconds: 75, totalPages: 300 }],
    progress: { sequence: 1, capturedAt: now().toISOString(), percent: 4.1 }, ...overrides };
}
export function bookOperation(id = 'book-00000001') {
  return { opId: randomUUID(), entity: 'book', id, baseVersion: 0, deleted: false,
    data: { title: 'Dom Casmurro', author: 'Machado de Assis', created_at: now().toISOString() } };
}

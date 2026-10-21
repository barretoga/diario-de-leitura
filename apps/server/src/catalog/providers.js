export class CatalogError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const validVolumeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
const text = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const strings = (value, count, length) => Array.isArray(value)
  ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, count).map(item => text(item, length)) : [];
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;

function googleVolume(row) {
  if (!row || !validVolumeId(row.id) || !row.volumeInfo || !text(row.volumeInfo.title, 500)) return null;
  const info = row.volumeInfo;
  let coverUri = null;
  const raw = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail;
  if (typeof raw === 'string') {
    try {
      const url = new URL(raw.replace(/^http:/, 'https:'));
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['books.google.com', 'books.googleusercontent.com'].includes(url.hostname)) coverUri = url.toString();
    } catch { /* Untrusted image URLs are omitted. */ }
  }
  const date = typeof info.publishedDate === 'string' ? info.publishedDate : '';
  const publishedYear = /^\d{4}(?:-|$)/.test(date) ? positive(Number(date.slice(0, 4))) : null;
  return { source: 'google', id: row.id, title: text(info.title, 500), authors: strings(info.authors, 3, 500),
    language: text(info.language, 12) || null, categories: strings(info.categories, 5, 120), coverUri, publishedYear,
    sourceUrl: `https://books.google.com/books?id=${encodeURIComponent(row.id)}` };
}

function openBooks(value, language) {
  if (!value || !Array.isArray(value.docs)) throw new CatalogError(502, 'invalid_response');
  const results = [];
  for (const row of value.docs) {
    if (!row || typeof row.key !== 'string' || !/^\/works\/OL\d+W$/.test(row.key) || !text(row.title, 500)) continue;
    const editions = Array.isArray(row.editions?.docs) ? row.editions.docs : [];
    const edition = language === 'pt'
      ? editions.find(item => item && text(item.title, 500) && Array.isArray(item.language) && item.language.includes('por'))
      : editions.find(item => item && text(item.title, 500));
    if (language === 'pt' && !edition) continue;
    const languages = Array.isArray(edition?.language) ? edition.language : [];
    results.push({ source: 'openlibrary', workKey: row.key, title: text(edition?.title || row.title, 500),
      authors: strings(row.author_name, 3, 500), editionLanguage: languages.includes('por') ? 'por' : languages.length ? 'other' : 'unknown',
      coverId: positive(edition?.cover_i) ?? positive(row.cover_i), subjects: strings(row.subject, 5, 120),
      firstPublishYear: positive(row.first_publish_year), sourceUrl: `https://openlibrary.org${row.key}` });
    if (results.length === 10) break;
  }
  return results;
}

async function requestJson(url, headers, fetchImpl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.toString(), { headers, signal, redirect: 'error' });
    if (!response.ok) throw new CatalogError(response.status === 429 ? 429 : 503,
      response.status === 429 ? 'rate_limited' : 'provider_unavailable');
    if (Number(response.headers.get('content-length')) > 2_000_000) {
      await response.body?.cancel();
      throw new CatalogError(502, 'invalid_response');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CatalogError(502, 'invalid_response');
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) { await reader.cancel(); throw new CatalogError(502, 'invalid_response'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CatalogError(502, 'invalid_response'); }
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    if (signal.aborted) throw new CatalogError(504, 'provider_timeout');
    throw new CatalogError(503, 'provider_unavailable');
  } finally {
    if (response && !response.ok) await response.body?.cancel().catch(() => {});
  }
}

export function createGoogleProvider({ key, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const headers = { 'x-goog-api-key': key };
  return {
    async search(title, author, language) {
      const url = new URL('https://www.googleapis.com/books/v1/volumes');
      url.searchParams.set('q', `intitle:${title}${author ? ` inauthor:${author}` : ''}`);
      url.searchParams.set('maxResults', '20'); url.searchParams.set('printType', 'books');
      if (language === 'pt') url.searchParams.set('langRestrict', 'pt');
      const value = await requestJson(url, headers, fetchImpl, timeoutMs);
      if (value?.items === undefined && value?.totalItems === 0) return [];
      if (!Array.isArray(value?.items)) throw new CatalogError(502, 'invalid_response');
      return value.items.map(googleVolume).filter(Boolean).slice(0, 20);
    },
    async getVolume(id) {
      if (!validVolumeId(id)) throw new CatalogError(400, 'invalid_request');
      const result = googleVolume(await requestJson(new URL(`https://www.googleapis.com/books/v1/volumes/${id}`), headers, fetchImpl, timeoutMs));
      if (!result || result.id !== id) throw new CatalogError(502, 'invalid_response');
      return result;
    },
  };
}

export function createOpenLibraryProvider({ contactEmail, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const headers = { 'User-Agent': `ReadingLogCatalog/1.0 (mailto:${contactEmail})` };
  return {
    async search(title, author, language) {
      const url = new URL('https://openlibrary.org/search.json');
      if (language === 'pt') { url.searchParams.set('q', `${title} language:por`); url.searchParams.set('lang', 'pt'); }
      else url.searchParams.set('title', title);
      if (author) url.searchParams.set('author', author);
      url.searchParams.set('limit', '10');
      url.searchParams.set('fields', 'key,title,author_name,cover_i,subject,first_publish_year,editions,editions.key,editions.title,editions.language,editions.cover_i');
      return openBooks(await requestJson(url, headers, fetchImpl, timeoutMs), language);
    },
  };
}

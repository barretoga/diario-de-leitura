import { fileURLToPath } from 'node:url';
import { createGoogleProvider, createOpenLibraryProvider } from './providers.js';
import { createCatalogServer } from './server.js';

export function readCatalogConfig(env) {
  const key = env.GOOGLE_BOOKS_API_KEY?.trim();
  const contactEmail = env.CATALOG_CONTACT_EMAIL?.trim();
  const port = Number(env.PORT ?? 8080);
  if (!key || /\s/.test(key)) throw new Error('Defina GOOGLE_BOOKS_API_KEY no servidor de catálogo.');
  if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new Error('Defina CATALOG_CONTACT_EMAIL com um email válido para identificar consultas.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve estar entre 1 e 65535.');
  return { key, contactEmail, port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { key, contactEmail, port } = readCatalogConfig(process.env);
    const server = createCatalogServer({ googleProvider: createGoogleProvider({ key }),
      openLibraryProvider: createOpenLibraryProvider({ contactEmail }) });
    server.listen(port, '0.0.0.0', () => console.log(`Catálogo de livros na porta ${port}`));
    server.on('error', () => { console.error('Não foi possível iniciar o catálogo. Confira a porta e a configuração.'); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

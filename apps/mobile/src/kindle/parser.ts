export const MAX_CLIPPINGS_BYTES = 10 * 1024 * 1024;
export type Clipping = {
  fingerprint: string; title: string; author: string; group: string;
  kind: "highlight" | "note" | "bookmark"; content: string;
  location: string | null; page: string | null; source_date: string | null;
};
export type Clippings = {
  entries: Clipping[];
  groups: { key: string; title: string; author: string; suggestedId: string }[];
  duplicates: number;
  rejected: { block: number; reason: string }[];
};
export const normalizeName = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const plain = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const range = (value: string | undefined) => value ? value.replace(/\s/g, "").replace(/[–—]/g, "-") : null;

export async function parseClippings(text: string, digest: (text: string) => Promise<string>): Promise<Clippings> {
  let bytes = 0;
  for (const char of text) { const cp = char.codePointAt(0)!; bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; }
  if (bytes > MAX_CLIPPINGS_BYTES) throw new Error("O arquivo deve ter até 10 MB.");
  if (text.includes("\0") || text.includes("\uFFFD")) throw new Error("Não foi possível ler o texto. Use um arquivo UTF-8.");
  const blocks = text.replace(/\r\n?/g, "\n").split(/^={10}\s*$/m).filter(block => block.trim());
  if (blocks.length > 10000) throw new Error("O arquivo deve ter até 10.000 trechos.");
  const output: Clippings = { entries: [], groups: [], duplicates: 0, rejected: [] };
  const seen = new Set<string>(), groups = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    const lines = block.replace(/^\s*\uFEFF?/, "").trim().split("\n");
    const header = lines[0]?.trim() ?? "", meta = lines[1]?.trim() ?? "";
    const reject = (reason: string) => output.rejected.push({ block: index + 1, reason });
    if (!header || !/^-\s*/.test(meta)) { reject("Cabeçalho ou metadados não reconhecidos."); continue; }
    const source = /^(.*)\s+\(([^()]*)\)$/.exec(header);
    const title = (source?.[1] ?? header).trim(), author = source?.[2]?.trim() ?? "";
    const normalizedMeta = plain(meta);
    const kindText = normalizedMeta.split("|")[0];
    const kind = /^-\s*(?:(?:your|seu|sua|o seu|a sua)\s+)?(?:highlight|destaque|sublinhado)\b/.test(kindText) ? "highlight"
      : /^-\s*(?:(?:your|seu|sua|o seu|a sua)\s+)?(?:note|nota)\b/.test(kindText) ? "note"
      : /^-\s*(?:(?:your|seu|sua|o seu|a sua)\s+)?(?:bookmark|marcador)\b/.test(kindText) ? "bookmark" : null;
    if (!kind) { reject("Tipo de anotação ou idioma não suportado."); continue; }
    const location = range(/\b(?:location|posicao|localizacao|pos\.)\s+(\d+(?:\s*[-–—]\s*\d+)?)/.exec(normalizedMeta)?.[1]);
    const page = range(/\b(?:page|pagina)\s+(\d+(?:\s*[-–—]\s*\d+)?)/.exec(normalizedMeta)?.[1]);
    const source_date = /(?:Added on|Adicionad[oa](?:\s+(?:em|a|na))?)\s*:?\s*(.+)$/i.exec(meta)?.[1]?.trim() ?? null;
    const content = lines.slice(2).join("\n").trim();
    if (!title || title.length > 500 || author.length > 500 || content.length > 10000 || (source_date?.length ?? 0) > 500 || (location?.length ?? 0) > 100 || (page?.length ?? 0) > 100) {
      reject("Trecho excede os limites de título, autor, texto ou metadados."); continue;
    }
    if ((!content && kind !== "bookmark") || (kind === "bookmark" && !location && !page)) { reject("Anotação sem conteúdo ou marcador sem posição."); continue; }
    if (/clipping limit|limite de (?:recorte|destaque)/i.test(content) && /^</.test(content)) { reject("O Kindle exportou um aviso de limite, sem o trecho."); continue; }
    const group = JSON.stringify([normalizeName(title), normalizeName(author)]);
    const fingerprint = await digest(JSON.stringify([group, kind, location, page,
      content.normalize("NFC").replace(/\s+/g, " ").trim(), location || page ? null : source_date]));
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Não foi possível identificar os trechos com SHA-256.");
    if (seen.has(fingerprint)) { output.duplicates++; continue; }
    seen.add(fingerprint);
    if (!groups.has(group)) {
      groups.add(group);
      output.groups.push({ key: group, title, author, suggestedId: `kindle-book-${await digest(group)}` });
    }
    output.entries.push({ fingerprint, title, author, group, kind, content, location, page, source_date });
  }
  return output;
}

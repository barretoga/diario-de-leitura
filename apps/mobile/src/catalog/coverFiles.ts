import { File, Paths } from "expo-file-system";
import { coverUrl } from "./openLibrary";

function coverFile(coverId: number) { return new File(Paths.document, `openlibrary-cover-${coverId}.jpg`); }

export function cachedCoverUri(coverId: number | null): string | null {
  if (coverId === null) return null;
  const file = coverFile(coverId);
  return file.exists && file.size > 0 ? file.uri : null;
}

export async function cacheCover(coverId: number | null): Promise<string | null> {
  if (coverId === null) return null;
  const file = coverFile(coverId);
  if (file.exists && file.size > 0) return file.uri;
  const temporary = new File(Paths.document, `openlibrary-cover-${coverId}.download`);
  try {
    if (temporary.exists) temporary.delete();
    const saved = await File.downloadFileAsync(coverUrl(coverId), temporary);
    if (!saved.exists || saved.size === 0) return null;
    if (file.exists && file.size === 0) file.delete();
    await saved.move(file);
    return file.uri;
  } catch {
    // Metadata remains available offline. A failed cover can be retried explicitly.
    return null;
  } finally {
    try { if (temporary.exists) temporary.delete(); } catch { /* Best effort cleanup. */ }
  }
}

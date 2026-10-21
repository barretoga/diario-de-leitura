export async function clearLegacyGoogleCredentials(deleteItemAsync: (key: string) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled([
    deleteItemAsync("google_books_api_key"),
    deleteItemAsync("google_books_android_certificate"),
  ]);
  if (results.some(result => result.status === "rejected")) throw new Error("Não foi possível remover a configuração antiga de catálogo.");
}

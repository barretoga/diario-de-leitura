export type DocumentSummary = { id: number; deviceId: string; generationId: string; documentId: string; title: string; author: string;
  state: "pending" | "linked" | "blocked"; bookId: string | null; associationVersion: number; error: { code: string; message: string } | null };
export type DocumentQuery = { state: "pending" | "linked" | "all"; after: number; limit: number };
export type DocumentPage = { documents: DocumentSummary[]; nextAfter: number | null };
export type KOReaderStatus = { protocolVersion: 1; timeZone: string; counts: { pending: number; linked: number; blocked: number }; lastReceiptAt: string | null };
export type LinkRequest = { bookId: string; expectedVersion: number };
export type KOReaderClient = { status(signal?: AbortSignal): Promise<KOReaderStatus>; documents(query: DocumentQuery, signal?: AbortSignal): Promise<DocumentPage>; link(id: number, input: LinkRequest, signal?: AbortSignal): Promise<{ document: DocumentSummary }> };

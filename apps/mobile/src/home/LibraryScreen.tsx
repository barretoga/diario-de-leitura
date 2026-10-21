import { useMemo, useState } from "react";
import { View, Text } from "react-native";
import type { Book, ReadingLog } from "../db";
import type { BookMetadata } from "../sync/store";
import { BookCover } from "../catalog/BookDetailScreen";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { ListRow } from "../ui/ListRow";
import { normalizedSearch } from "./historyGroups";
import { ui } from "../ui/tokens";
export function LibraryScreen({ books, logs, metadata, onAdd, onOpen }: { books: Book[]; logs: ReadingLog[]; metadata: BookMetadata[]; onAdd: () => void; onOpen: (book: Book) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => books.filter(book => normalizedSearch(book.title + " " + book.author).includes(normalizedSearch(query.trim()))), [books, query]);
  return <View style={ui.stack}><Field icon="search" label="Buscar livros" value={query} onChangeText={setQuery} placeholder="Título ou autor" /><Button icon="add" label="Adicionar livro" onPress={onAdd} />
    {!books.length && <Text style={ui.muted}>Sua biblioteca começa com um livro.</Text>}
    {!!books.length && !filtered.length && <Text style={ui.muted}>Nenhum livro encontrado.</Text>}
    <View>{filtered.map(book => { const count = logs.filter(log => log.book_id === book.id).length; return <ListRow key={book.id} title={book.title} subtitle={[book.author, count + (count === 1 ? " leitura" : " leituras")].filter(Boolean).join(" · ")} leading={<BookCover coverId={metadata.find(item => item.book_id === book.id)?.cover_id ?? null} />} onPress={() => onOpen(book)} />; })}</View>
  </View>;
}

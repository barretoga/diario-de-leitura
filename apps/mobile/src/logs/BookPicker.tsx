import { useEffect, useState, type RefObject } from "react";
import { FlatList, Text, View } from "react-native";
import type { Book } from "../db";
import { normalizedSearch } from "../home/historyGroups";
import { Field } from "../ui/Field";
import { ListRow } from "../ui/ListRow";
import { Overlay } from "../ui/Overlay";
import { ui } from "../ui/tokens";
export function BookPicker({ visible, books, selectedId, onSelect, onClose, returnFocusRef }: { visible: boolean; books: Book[]; selectedId: string; onSelect: (id: string) => void; onClose: () => void; returnFocusRef?: RefObject<View | null> }) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (visible) setQuery(""); }, [visible]);
  const filtered = books.filter(book => normalizedSearch(`${book.title} ${book.author}`).includes(normalizedSearch(query.trim())));
  return <Overlay visible={visible} title="Escolher livro" onClose={onClose} returnFocusRef={returnFocusRef}>
    <Field icon="search" label="Buscar livro" value={query} onChangeText={setQuery} placeholder="Título ou autor" />
    <FlatList style={{ maxHeight: 380, flexShrink: 1 }} keyboardShouldPersistTaps="handled" data={filtered} keyExtractor={book => book.id}
      ListEmptyComponent={<Text style={ui.muted}>Nenhum livro encontrado.</Text>} renderItem={({ item }) => <ListRow title={item.title} subtitle={[item.author, item.id === selectedId ? "Selecionado" : ""].filter(Boolean).join(" · ")} onPress={() => onSelect(item.id)} />} />
  </Overlay>;
}

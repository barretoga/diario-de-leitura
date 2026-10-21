import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { ReadingLog } from "../db";
import { groupHistory } from "./historyGroups";
import { ReadingLogRow } from "../logs/ReadingLogRow";
import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import { Section } from "../ui/Section";
import { ui } from "../ui/tokens";
export function HistoryScreen({ logs, onEdit, onDelete, onRead }: { logs: ReadingLog[]; onEdit: (log: ReadingLog) => void; onDelete: (log: ReadingLog) => void; onRead: () => void }) {
  const [query, setQuery] = useState(""); const [limit, setLimit] = useState(20);
  const result = useMemo(() => groupHistory(logs, query, limit), [logs, query, limit]);
  return <View style={[ui.stack, { gap: 24 }]}><Field icon="search" label="Buscar leituras" value={query} onChangeText={value => { setQuery(value); setLimit(20); }} placeholder="Livro, nota ou data" />
    {!logs.length && <><Text style={ui.muted}>Nenhuma leitura registrada.</Text><Button icon="edit" label="Registrar leitura" onPress={onRead} /></>}
    {!!logs.length && !result.total && <Text style={ui.muted}>Nenhuma leitura encontrada.</Text>}
    {result.groups.map(group => <Section key={group.key} title={group.date.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" })}><View>{group.logs.map(log => <ReadingLogRow key={log.id} log={log} onEdit={onEdit} onDelete={onDelete} />)}</View></Section>)}
    {result.total > limit && <Button label="Mostrar mais leituras" variant="text" onPress={() => setLimit(limit + 20)} />}
  </View>;
}

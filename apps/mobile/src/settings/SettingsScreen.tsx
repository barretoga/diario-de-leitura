import { View } from "react-native";
import { ListRow } from "../ui/ListRow";
import { Section } from "../ui/Section";
import { ui } from "../ui/tokens";
import { IconBadge } from "../ui/ActionIcon";
export function SettingsScreen({ syncSummary, onSync, onBackup, onKindle, onKOReader }: { syncSummary: string; onSync: () => void; onBackup: () => void; onKindle: () => void; onKOReader: () => void }) {
  return <View style={[ui.stack, { gap: 32 }]}>
    <Section title="Sincronização">
      <ListRow title="Sincronização" subtitle={syncSummary} leading={<IconBadge name="sync" />} onPress={onSync} />
      <ListRow title="KOReader" subtitle="Tempo e progresso do Kindle" leading={<IconBadge name="book" />} onPress={onKOReader} />
    </Section>
    <Section title="Dados">
      <ListRow title="Backup e restauração" leading={<IconBadge name="backup" />} onPress={onBackup} />
      <ListRow title="Anotações Kindle" leading={<IconBadge name="annotation" />} onPress={onKindle} />
    </Section>
  </View>;
}

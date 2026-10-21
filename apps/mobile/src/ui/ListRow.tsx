import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ActionIcon } from "./ActionIcon";
import { colors } from "./tokens";
export type ListRowProps = { title: string; subtitle?: string; leading?: ReactNode; trailing?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
export function ListRow({ title, subtitle, leading, trailing, onPress, accessibilityLabel }: ListRowProps) {
  const content = <>{leading}<View style={styles.text}><Text numberOfLines={2} style={styles.title}>{title}</Text>{!!subtitle && <Text numberOfLines={2} style={styles.subtitle}>{subtitle}</Text>}</View>{trailing ?? (onPress && <ActionIcon name="chevron" color={colors.muted} size={20} />)}</>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? [title, subtitle].filter(Boolean).join(", ")} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.soft }]}>{content}</Pressable> : <View style={styles.row}>{content}</View>;
}
const styles = StyleSheet.create({ row: { minHeight: 64, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, text: { flex: 1, gap: 4 }, title: { color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: "600" }, subtitle: { color: colors.muted, fontSize: 14, lineHeight: 21 } });

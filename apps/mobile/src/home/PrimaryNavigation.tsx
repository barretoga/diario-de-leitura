import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { NavigationIcon } from "./NavigationIcon";
import { colors } from "../ui/tokens";
import type { PrimaryScreen } from "../navigation/routes";
import { usePressScale } from "../ui/Motion";

export type { PrimaryScreen } from "../navigation/routes";
function NavigationItem({ screen, label, selected, onPress }: { screen: PrimaryScreen; label: string; selected: boolean; onPress: () => void }) {
  const motion = usePressScale();
  return <Pressable accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} onPressIn={motion.onPressIn} onPressOut={motion.onPressOut} style={styles.item}>
    <Animated.View accessible={false} style={[styles.iconPill, selected && styles.selected, { transform: [{ scale: motion.scale }] }]}><NavigationIcon screen={screen} selected={selected} /></Animated.View>
    <Text style={[styles.label, selected && styles.selectedLabel]}>{label}</Text>
  </Pressable>;
}

const items: { screen: PrimaryScreen; label: string }[] = [
  { screen: "history", label: "Início" },
  { screen: "all-logs", label: "Histórico" },
  { screen: "statistics", label: "Estatísticas" },
  { screen: "library", label: "Livros" },
];

export function PrimaryNavigation({ current, onNavigate }: { current: PrimaryScreen; onNavigate: (screen: PrimaryScreen) => void }) {
  return <View accessibilityRole="tablist" style={styles.bar}>
    {items.map(item => <NavigationItem key={item.screen} screen={item.screen} label={item.label} selected={current === item.screen} onPress={() => onNavigate(item.screen)} />)}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 8, paddingTop: 8 },
  item: { flex: 1, minHeight: 64, paddingHorizontal: 2, paddingVertical: 4, alignItems: "center", justifyContent: "center", gap: 2 },
  iconPill: { width: 56, height: 32, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  selected: { backgroundColor: colors.soft },
  label: { color: colors.muted, fontSize: 14, fontWeight: "500", textAlign: "center" },
  selectedLabel: { color: colors.accent, fontWeight: "700" },
});

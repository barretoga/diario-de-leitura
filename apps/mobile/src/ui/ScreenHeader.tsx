import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ActionIcon } from "./ActionIcon";
import { colors, typography } from "./tokens";
export type ScreenHeaderProps = { title: string; onBack?: () => void; backDisabled?: boolean; onSettings?: () => void; actions?: ReactNode };
export function ScreenHeader({ title, onBack, backDisabled = false, onSettings, actions }: ScreenHeaderProps) {
  return <View style={styles.header}>{onBack && <Pressable disabled={backDisabled} accessibilityRole="button" accessibilityLabel="Voltar" accessibilityState={{ disabled: backDisabled }} onPress={onBack} style={[styles.touch, backDisabled && { opacity: 0.5 }]}><ActionIcon name="back" /></Pressable>}<Text accessibilityRole="header" style={styles.title}>{title}</Text>{actions}{onSettings && <Pressable accessibilityRole="button" accessibilityLabel="Configurações" onPress={onSettings} style={styles.touch}><ActionIcon name="settings" /></Pressable>}</View>;
}
const styles = StyleSheet.create({ header: { flexDirection: "row", alignItems: "center", minHeight: 72, paddingHorizontal: 12, paddingVertical: 12, gap: 4, backgroundColor: colors.background }, title: { ...typography.screen, flex: 1, color: colors.ink, marginHorizontal: 8 }, touch: { minWidth: 48, minHeight: 48, borderRadius: 16, backgroundColor: colors.soft, alignItems: "center", justifyContent: "center" } });

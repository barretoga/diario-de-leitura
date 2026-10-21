import { useEffect, useRef } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "./tokens";
import { ActionIcon } from "./ActionIcon";
export type FeedbackProps = { kind: "success" | "error" | "notice"; message: string; onDismiss?: () => void };
export function Feedback({ kind, message, onDismiss }: FeedbackProps) {
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useEffect(() => { if (kind !== "success") return; AccessibilityInfo.announceForAccessibility(message); const timeout = setTimeout(() => dismiss.current?.(), 4000); return () => clearTimeout(timeout); }, [kind, message]);
  return <View accessibilityLiveRegion={kind === "success" ? "none" : "polite"} style={[styles.notice, kind === "error" && { backgroundColor: colors.dangerSoft }, kind === "notice" && { backgroundColor: colors.warm }]}><ActionIcon name={kind === "success" ? "success" : kind === "error" ? "warning" : "info"} size={22} color={kind === "error" ? colors.danger : kind === "notice" ? colors.warning : colors.accent} /><Text style={[styles.text, kind === "error" && { color: colors.danger }]}>{message}</Text>{onDismiss && <Pressable accessibilityRole="button" accessibilityLabel="Dispensar mensagem" onPress={onDismiss} style={styles.dismiss}><ActionIcon name="close" size={20} /></Pressable>}</View>;
}
const styles = StyleSheet.create({ notice: { paddingVertical: 8, paddingLeft: 16, paddingRight: 8, backgroundColor: colors.soft, borderRadius: 14, flexDirection: "row", alignItems: "center", gap: 10 }, text: { flex: 1, color: colors.ink, fontSize: 14, lineHeight: 21 }, dismiss: { minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }, link: { color: colors.accent, fontSize: 14, fontWeight: "600" } });

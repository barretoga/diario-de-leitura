import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActionIcon } from "./ActionIcon";
import { Button } from "./Button";
import { colors, elevation, typography } from "./tokens";
import { useReducedMotion } from "./Motion";
export type OverlayProps = { visible: boolean; title: string; onClose: () => void; returnFocusRef?: RefObject<View | null>; children: ReactNode };
export function Overlay({ visible, title, onClose, returnFocusRef, children }: OverlayProps) {
  const heading = useRef<Text>(null); const wasOpen = useRef(false);
  const reduced = useReducedMotion();
  useEffect(() => { if (!visible && !wasOpen.current) return; wasOpen.current = visible; const timeout = setTimeout(() => { const target = visible ? heading.current : returnFocusRef?.current; if (target) { const node = findNodeHandle(target); if (node) AccessibilityInfo.setAccessibilityFocus(node); } }, 350); return () => clearTimeout(timeout); }, [visible, returnFocusRef]);
  return <Modal visible={visible} transparent animationType={reduced ? "none" : "fade"} onRequestClose={onClose}><KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}><SafeAreaView edges={["bottom"]} accessibilityViewIsModal style={[styles.sheet, elevation.sheet]}><View accessible={false} style={styles.handle} /><View style={styles.header}><Text ref={heading} accessibilityRole="header" accessibilityLabel={title} numberOfLines={2} style={styles.title}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Fechar ${title}`} onPress={onClose} style={styles.close}><ActionIcon name="close" size={22} /></Pressable></View>{children}</SafeAreaView></KeyboardAvoidingView></Modal>;
}
export type MenuAction = { label: string; onPress: () => void; disabled?: boolean; danger?: boolean };
export function ActionMenu({ label = "Mais opções", items, disabled = false }: { label?: string; items: MenuAction[]; disabled?: boolean }) {
  const [visible, setVisible] = useState(false); const trigger = useRef<View>(null);
  return <><Pressable ref={trigger} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: visible, disabled }} onPress={() => setVisible(true)} style={styles.close}><ActionIcon name="more" /></Pressable><Overlay visible={visible} title={label} onClose={() => setVisible(false)} returnFocusRef={trigger}>{items.map(item => <Button key={item.label} label={item.label} disabled={item.disabled} variant={item.danger ? "danger" : "text"} onPress={() => { setVisible(false); item.onPress(); }} />)}</Overlay></>;
}
const styles = StyleSheet.create({ backdrop: { flex: 1, backgroundColor: "rgba(24,35,28,0.32)", justifyContent: "flex-end" }, sheet: { maxHeight: "90%", backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 12 }, handle: { alignSelf: "center", width: 32, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 4 }, header: { flexDirection: "row", alignItems: "center", gap: 8 }, title: { ...typography.section, flex: 1, color: colors.ink }, close: { minWidth: 48, minHeight: 48, borderRadius: 16, alignItems: "center", justifyContent: "center" }, closeText: { color: colors.accent, fontSize: 14, fontWeight: "600" } });

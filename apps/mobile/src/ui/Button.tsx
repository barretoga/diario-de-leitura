import { ActivityIndicator, Animated, Pressable, StyleSheet, Text } from "react-native";
import { ActionIcon, type IconName } from "./ActionIcon";
import { usePressScale } from "./Motion";
import { colors, elevation } from "./tokens";
export type ButtonProps = { label: string; onPress: () => void; icon?: IconName; variant?: "primary" | "secondary" | "text" | "danger"; disabled?: boolean; busy?: boolean; secondary?: boolean };
export function Button({ label, onPress, icon, variant = "primary", disabled = false, busy = false, secondary = false }: ButtonProps) {
  const kind = secondary ? "secondary" : variant; const blocked = disabled || busy;
  const motion = usePressScale(blocked);
  const foreground = kind === "primary" ? colors.surface : kind === "danger" ? colors.danger : colors.accent;
  return <Animated.View style={{ transform: [{ scale: motion.scale }] }}><Pressable accessibilityRole="button" accessibilityState={{ disabled: blocked, busy }} disabled={blocked} onPress={onPress} onPressIn={motion.onPressIn} onPressOut={motion.onPressOut} style={({ pressed }) => [styles.button, kind === "primary" && elevation.action, kind !== "primary" && styles.secondary, kind === "text" && styles.textButton, kind === "danger" && styles.dangerButton, blocked && styles.disabled, pressed && { backgroundColor: kind === "primary" ? colors.accentPressed : kind === "danger" ? colors.dangerSoft : colors.soft }]}>
    {busy ? <ActivityIndicator color={foreground} /> : icon ? <ActionIcon name={icon} color={foreground} size={20} /> : null}<Text style={[styles.label, { color: foreground }]}>{label}</Text>
  </Pressable></Animated.View>;
}
const styles = StyleSheet.create({ button: { minHeight: 56, paddingVertical: 14, paddingHorizontal: 18, borderRadius: 14, backgroundColor: colors.accent, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 }, secondary: { backgroundColor: colors.soft }, textButton: { backgroundColor: "transparent" }, dangerButton: { backgroundColor: colors.dangerSoft }, label: { fontSize: 16, lineHeight: 24, fontWeight: "600", textAlign: "center", flexShrink: 1 }, disabled: { opacity: 0.5 } });

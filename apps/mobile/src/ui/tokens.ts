import { StyleSheet } from "react-native";
export const colors = {
  background: "#F6F4EE", surface: "#FFFFFF", ink: "#202923", muted: "#606A61",
  accent: "#245C45", accentPressed: "#194633", border: "#DEDCD3", outline: "#7A847B",
  soft: "#E8F0E9", warm: "#F5E8D4", amber: "#8F5818", danger: "#A13B3B",
  dangerSoft: "#F8E9E6", warning: "#76521A",
};
export const typography = StyleSheet.create({
  screen: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.6 },
  section: { fontSize: 18, lineHeight: 26, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 24 }, secondary: { fontSize: 14, lineHeight: 21 },
  metric: { fontSize: 32, lineHeight: 40, fontWeight: "600", letterSpacing: -0.7, fontVariant: ["tabular-nums"] },
});
export const elevation = StyleSheet.create({
  action: { shadowColor: colors.accent, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12, shadowRadius: 5, elevation: 2 },
  sheet: { shadowColor: colors.ink, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 8 },
});
export const ui = StyleSheet.create({
  stack: { gap: 16 }, title: { ...typography.section, color: colors.ink },
  body: { ...typography.body, color: colors.ink }, muted: { ...typography.secondary, color: colors.muted },
  error: { ...typography.secondary, color: colors.danger },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
});

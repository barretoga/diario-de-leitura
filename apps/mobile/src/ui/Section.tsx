import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "./tokens";
import { ActionIcon, type IconName } from "./ActionIcon";
export type SectionProps = { title?: string; icon?: IconName; iconColor?: string; action?: ReactNode; children: ReactNode };
export function Section({ title, icon, iconColor, action, children }: SectionProps) { return <View style={styles.section}>{(title || action) && <View style={styles.header}>{icon && <ActionIcon name={icon} size={20} color={iconColor} />}{title && <Text accessibilityRole="header" style={styles.title}>{title}</Text>}{action}</View>}{children}</View>; }
const styles = StyleSheet.create({ section: { gap: 12 }, header: { flexDirection: "row", alignItems: "center", gap: 12 }, title: { flex: 1, fontSize: 18, fontWeight: "600", color: colors.ink } });

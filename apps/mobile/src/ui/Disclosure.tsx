import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, ui } from "./tokens";
import { ActionIcon } from "./ActionIcon";
export function Disclosure({ title, children, initialOpen = false }: { title: string; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <View style={{ gap: 12 }}><Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}><Text style={{ color: colors.accent, fontSize: 14, fontWeight: "500", flex: 1 }}>{title}</Text><ActionIcon name={open ? "up" : "down"} size={20} /></Pressable>{open && <View style={ui.stack}>{children}</View>}</View>;
}

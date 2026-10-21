import { Ionicons } from "@react-native-vector-icons/ionicons";
import { View } from "react-native";
import { colors } from "./tokens";

const glyphs = {
  back: "arrow-back", settings: "settings-outline", more: "ellipsis-horizontal", add: "add",
  search: "search-outline", timer: "timer-outline", chevron: "chevron-forward", down: "chevron-down",
  up: "chevron-up", book: "book-outline", external: "open-outline", home: "home-outline",
  history: "list-outline", chart: "stats-chart-outline", flame: "flame-outline", goal: "flag-outline",
  trophy: "trophy-outline", check: "checkmark", success: "checkmark-circle-outline",
  info: "information-circle-outline", warning: "alert-circle-outline", sync: "sync-outline",
  backup: "cloud-download-outline", annotation: "document-text-outline", edit: "create-outline",
  delete: "trash-outline", close: "close", play: "play", pause: "pause", save: "checkmark",
  calendar: "calendar-outline", clock: "time-outline", note: "chatbubble-outline", progress: "trending-up-outline",
} as const;
export type IconName = keyof typeof glyphs;
const filled = { home: "home", history: "list", chart: "stats-chart", book: "book", flame: "flame", trophy: "trophy", goal: "flag" } as const;
export function ActionIcon({ name, size = 24, color = colors.accent, selected = false }: { name: IconName; size?: number; color?: string; selected?: boolean }) {
  const glyph = selected && name in filled ? filled[name as keyof typeof filled] : glyphs[name];
  return <Ionicons accessible={false} importantForAccessibility="no" name={glyph} size={size} color={color} />;
}
export function IconBadge({ name, warm = false, size = 40 }: { name: IconName; warm?: boolean; size?: number }) {
  return <View accessible={false} style={{ width: size, height: size, borderRadius: 12, backgroundColor: warm ? colors.warm : colors.soft, alignItems: "center", justifyContent: "center" }}><ActionIcon name={name} size={22} color={warm ? colors.amber : colors.accent} /></View>;
}

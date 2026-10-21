import type { PrimaryScreen } from "./PrimaryNavigation";
import { ActionIcon, type IconName } from "../ui/ActionIcon";
import { colors } from "../ui/tokens";
const icons: Record<PrimaryScreen, IconName> = { history: "home", "all-logs": "history", statistics: "chart", library: "book" };
export function NavigationIcon({ screen, selected }: { screen: PrimaryScreen; selected: boolean }) {
  return <ActionIcon name={icons[screen]} selected={selected} color={selected ? colors.accent : colors.muted} />;
}

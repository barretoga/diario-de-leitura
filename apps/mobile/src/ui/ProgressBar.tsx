import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useReducedMotion } from "./Motion";
import { colors } from "./tokens";

export function ProgressBar({ fraction, label, now, max, warm = false }: { fraction: number; label: string; now: number; max: number; warm?: boolean }) {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const width = useRef(new Animated.Value(bounded)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    width.stopAnimation();
    if (reduced) width.setValue(bounded);
    else Animated.timing(width, { toValue: bounded, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    return () => width.stopAnimation();
  }, [bounded, reduced, width]);
  return <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max, now: Math.min(max, Math.max(0, now)) }} style={[styles.track, warm && { backgroundColor: colors.warm }]}><Animated.View style={[styles.fill, { backgroundColor: warm ? colors.amber : colors.accent, width: width.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} /></View>;
}
const styles = StyleSheet.create({ track: { height: 7, width: "100%", backgroundColor: colors.soft, borderRadius: 4, overflow: "hidden" }, fill: { height: 7, borderRadius: 4 } });

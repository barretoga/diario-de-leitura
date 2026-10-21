import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { observeReducedMotion } from "./reducedMotion";

const ReducedMotion = createContext(true);
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => observeReducedMotion({
    getCurrent: () => AccessibilityInfo.isReduceMotionEnabled(),
    subscribe: listener => {
      const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", listener);
      return () => subscription.remove();
    },
    onChange: setReduced,
  }), []);
  return <ReducedMotion.Provider value={reduced}>{children}</ReducedMotion.Provider>;
}
export function useReducedMotion() { return useContext(ReducedMotion); }

export function usePressScale(disabled = false) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced || disabled) { scale.stopAnimation(); scale.setValue(1); }
    return () => scale.stopAnimation();
  }, [reduced, disabled, scale]);
  function animate(pressed: boolean) {
    scale.stopAnimation();
    if (reduced || disabled) { scale.setValue(1); return; }
    Animated.timing(scale, { toValue: pressed ? 0.98 : 1, duration: pressed ? 100 : 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }
  return { scale, onPressIn: () => animate(true), onPressOut: () => animate(false) };
}

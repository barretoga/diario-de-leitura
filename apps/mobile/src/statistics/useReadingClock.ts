import { useEffect, useState } from "react";
import { AppState } from "react-native";

export function useReadingClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function active(state: string) {
      clearInterval(timer);
      if (state === "active") {
        setNow(new Date());
        timer = setInterval(() => setNow(new Date()), 60000);
      }
    }
    active(AppState.currentState);
    const listener = AppState.addEventListener("change", active);
    return () => { clearInterval(timer); listener.remove(); };
  }, []);
  return now;
}

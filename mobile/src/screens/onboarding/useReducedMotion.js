import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Same one-shot check DailyWelcomeOverlay uses: read the OS "reduce motion"
 * flag once on mount and swallow a failed read. Every animated tour screen
 * uses this to decide whether to run its entrance sequence or snap straight
 * to the final resting state.
 */
export function useReducedMotion() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => {
        if (!cancelled) setReduceMotion(!!v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return reduceMotion;
}

import React, { useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Animated } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useThemeColors } from "../theme/useThemeColors";
import Icon, { IconName } from "./Icon";
import type { AbsTask } from "../utils/abs/types";

// action → leading glyph. Real ABS actions are compound ("library-scan",
// "encode-m4b", "embed-metadata", ...), so match by fragment; anything the
// server adds later falls back to the generic activity pulse.
const ACTION_ICONS: Array<[fragment: string, icon: IconName]> = [
  ["scan", "refresh"],
  ["encode", "music"],
  ["embed", "edit"],
  ["match", "search"],
  ["backup", "database"],
];

function iconForAction(action: string): IconName {
  const hit = ACTION_ICONS.find(([fragment]) => action.includes(fragment));
  return hit ? hit[1] : "activity";
}

/** "62s" → "1m 2s" → "1h 4m" — coarse elapsed formatting for task sublabels. */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * One server task (scan/encode/embed/match/backup) as a list row. Pure
 * presentational: it renders the AbsTask snapshot it's given — polling and
 * subscription live with the caller (usePolling / subscribeTasks), never here.
 *
 * Right-side status: a spinner while the task runs, an error glyph when it
 * failed, and a one-shot scale-in check when it finished (the pop only plays
 * when the row transitions to finished while mounted; reduce-motion renders
 * the check statically).
 *
 * PERSISTENCE CAVEAT: the upstream ABS TaskManager REMOVES tasks from
 * GET /api/tasks the moment they complete — failures included — so a
 * finished/failed row usually vanishes on the next poll rather than settling
 * here (it may flash for one tick, or never appear at all). This row must
 * therefore never assume its terminal states persist: it just renders the
 * snapshot it's given, and the check pop is best-effort (it plays only if a
 * running→finished transition happens to be observed while mounted).
 */
export default function TaskProgressRow({
  task,
  onPress,
}: {
  task: AbsTask;
  onPress?: () => void;
}) {
  const colors = useThemeColors();
  const reduceMotion = useReducedMotion();

  const finished = task.isFinished && !task.isFailed;
  const running = !task.isFinished && !task.isFailed;

  // One-shot check pop: starts at full scale if the row mounts already
  // finished (list re-render), springs in only on the running→finished
  // transition observed while mounted.
  const wasFinishedAtMount = useRef(finished);
  const checkScale = useRef(new Animated.Value(finished ? 1 : 0)).current;
  useEffect(() => {
    if (!finished) return;
    if (wasFinishedAtMount.current) return;
    wasFinishedAtMount.current = true;
    if (reduceMotion) {
      checkScale.setValue(1);
      return;
    }
    Animated.spring(checkScale, {
      toValue: 1,
      bounciness: 12,
      speed: 16,
      useNativeDriver: true,
    }).start();
  }, [finished, reduceMotion, checkScale]);

  const sublabel = task.isFailed
    ? task.error || "Failed"
    : task.isFinished && task.finishedAt
    ? `Finished in ${formatElapsed(task.finishedAt - task.startedAt)}`
    : `Running for ${formatElapsed(Date.now() - task.startedAt)}`;

  const inner = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 14,
        paddingHorizontal: 20,
      }}
    >
      <Icon
        name={iconForAction(task.action)}
        size={24}
        color={task.isFailed ? colors.error : colors.onSurfaceVariant}
        style={{ marginRight: 16 }}
      />
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={{ color: colors.onSurface, fontSize: 16 }} numberOfLines={1}>
          {task.title}
        </Text>
        <Text
          style={{
            color: task.isFailed ? colors.error : colors.onSurfaceVariant,
            fontSize: 13,
            marginTop: 2,
          }}
          numberOfLines={2}
        >
          {sublabel}
        </Text>
      </View>
      {task.isFailed ? (
        <Icon name="warning" size={22} color={colors.error} />
      ) : running ? (
        <ActivityIndicator testID="task-row-spinner" size="small" color={colors.primary} />
      ) : (
        <Animated.View style={{ transform: [{ scale: checkScale }] }}>
          <Icon name="check" size={22} color={colors.primary} />
        </Animated.View>
      )}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${task.title}, ${sublabel}`}
        testID="task-progress-row"
      >
        {inner}
      </TouchableOpacity>
    );
  }
  return (
    <View accessible accessibilityLabel={`${task.title}, ${sublabel}`} testID="task-progress-row">
      {inner}
    </View>
  );
}

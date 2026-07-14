import React, { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import { withAlpha } from "../theme/palette";
import TaskProgressRow from "./TaskProgressRow";
import type { AbsTask } from "../utils/abs/types";

// How many task rows the collapsed card shows before offering "View all (n)".
const COLLAPSED_ROWS = 2;

/**
 * Running-tasks summary card for the Server Admin hub (UX plan §F1): a
 * surfaceContainerHigh radius-14 card (the StatsScreen card idiom) listing the
 * server's in-flight/failed tasks as TaskProgressRows. Purely presentational —
 * the caller owns the subscribeTasks() subscription and hands the latest
 * snapshot down; this component only decides what is worth showing:
 *
 *  - running tasks always;
 *  - failed tasks whenever a snapshot catches them — NOTE the upstream ABS
 *    TaskManager removes completed tasks (failures included) from
 *    GET /api/tasks immediately, so a failed row typically appears for at
 *    most one poll tick before vanishing; durable failure surfacing belongs
 *    to the flows that watch specific tasks (startTaskWatch → snackbar),
 *    not this card;
 *  - successfully finished tasks are dropped (the strip collapses back to
 *    nothing when the queue drains — no empty card, per the UX plan).
 *
 * More than COLLAPSED_ROWS visible tasks collapse behind a "View all (n)"
 * footer. When the caller passes `onViewAll` (the hub opening its TasksSheet
 * — issue #64), the footer delegates there; without it, the footer falls back
 * to expanding the list in place.
 */
export default function TaskActivityCard({
  tasks,
  onViewAll,
}: {
  tasks: AbsTask[];
  onViewAll?: () => void;
}) {
  const colors = useThemeColors();
  const [expanded, setExpanded] = useState(false);

  const visible = tasks.filter((t) => !t.isFinished || t.isFailed);
  if (visible.length === 0) return null;

  const runningCount = visible.filter((t) => !t.isFinished).length;
  const failedCount = visible.length - runningCount;
  const summaryParts: string[] = [];
  if (runningCount) summaryParts.push(`${runningCount} running`);
  if (failedCount) summaryParts.push(`${failedCount} failed`);
  const summary = summaryParts.join(" · ");

  const shown = expanded ? visible : visible.slice(0, COLLAPSED_ROWS);
  const hiddenCount = visible.length - shown.length;

  return (
    <View
      testID="task-activity-card"
      style={{
        backgroundColor: colors.surfaceContainerHigh,
        borderRadius: 14,
        marginHorizontal: 20,
        marginTop: 16,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 20,
          paddingTop: 14,
        }}
      >
        <Text
          style={{
            color: colors.onSurfaceVariant,
            fontSize: 13,
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Server activity
        </Text>
        {/* The live region is THIS summary text only — it changes when task
            counts change, not on every 3s poll re-render, so screen readers
            hear "1 running" transitions instead of a per-tick firehose. */}
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: colors.onSurfaceVariant, fontSize: 13 }}
        >
          {summary}
        </Text>
      </View>
      {shown.map((task) => (
        <TaskProgressRow key={task.id} task={task} />
      ))}
      {visible.length > COLLAPSED_ROWS ? (
        <TouchableOpacity
          onPress={() => (onViewAll ? onViewAll() : setExpanded((e) => !e))}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Show fewer tasks" : `View all ${visible.length} tasks`}
          style={{
            paddingVertical: 12,
            alignItems: "center",
            borderTopWidth: 1,
            borderTopColor: withAlpha(colors.outlineVariant, 0.6),
          }}
        >
          <Text style={{ color: colors.primary, fontSize: 14, fontWeight: "600" }}>
            {expanded ? "Show fewer" : hiddenCount > 0 ? `View all (${visible.length})` : "View all"}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

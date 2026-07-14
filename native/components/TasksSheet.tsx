import React from "react";
import { View, Text, ScrollView } from "react-native";
import BottomSheet from "./BottomSheet";
import TaskProgressRow from "./TaskProgressRow";
import { useThemeColors } from "../theme/useThemeColors";
import type { AbsTask } from "../utils/abs/types";

/**
 * TasksSheet — the full server-activity list behind TaskActivityCard's
 * "View all" footer on the Server Admin hub (issue #64). Purely
 * presentational: the caller owns the subscribeTasks() subscription and
 * hands the live snapshot down, so the sheet's rows update in place while
 * it is open.
 *
 * Unlike the card (which hides successfully finished tasks), this sheet
 * lists EVERY task in the snapshot unfiltered — running, failed, and
 * finished alike — via TaskProgressRow with its description line enabled.
 *
 * READ-ONLY BY DESIGN: ABS v2.35.1 exposes NO task-cancel REST endpoint
 * (the server's TaskManager has no abort/DELETE route), so rows are
 * strictly informational — no cancel affordance can exist here.
 *
 * NO DURABLE HISTORY: the upstream TaskManager removes tasks from
 * GET /api/tasks the moment they complete, so finished tasks vanish from
 * this sheet as soon as ABS drops them from the snapshot.
 */
export default function TasksSheet({
  visible,
  tasks,
  onClose,
}: {
  visible: boolean;
  tasks: AbsTask[];
  onClose: () => void;
}) {
  const colors = useThemeColors();

  const runningCount = tasks.filter((t) => !t.isFinished && !t.isFailed).length;
  const failedCount = tasks.filter((t) => t.isFailed).length;
  const summaryParts: string[] = [];
  if (runningCount) summaryParts.push(`${runningCount} running`);
  if (failedCount) summaryParts.push(`${failedCount} failed`);
  const summary = summaryParts.join(" · ");

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 24,
          paddingTop: 4,
          paddingBottom: 6,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ fontSize: 18, fontWeight: "600", color: colors.onSurface }}
        >
          Server activity
        </Text>
        {summary ? (
          <Text style={{ color: colors.onSurfaceVariant, fontSize: 13 }}>{summary}</Text>
        ) : null}
      </View>
      <ScrollView>
        {tasks.length === 0 ? (
          <Text
            style={{
              color: colors.onSurfaceVariant,
              fontSize: 14,
              paddingHorizontal: 24,
              paddingVertical: 20,
            }}
          >
            No server activity right now.
          </Text>
        ) : (
          tasks.map((task) => <TaskProgressRow key={task.id} task={task} showDescription />)
        )}
      </ScrollView>
    </BottomSheet>
  );
}

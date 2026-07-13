import React, { useEffect, useState } from "react";
import { View, Text } from "react-native";
import BottomSheet from "./BottomSheet";
import StatusChip from "./StatusChip";
import { useThemeColors } from "../theme/useThemeColors";
import { formatListeningTime, formatDateTime } from "../utils/format";
import type { AbsListeningSession } from "../utils/abs/types";

/**
 * SessionDetailSheet — read-only details for a single listening session, opened
 * by tapping a row on AdminSessionsScreen. No destructive actions live here
 * (delete stays on the row / selection header); this sheet only surfaces the
 * full anatomy of a session that the compact row can't show.
 *
 * `isOpen` reflects the live /api/users/online poll — an "Open" chip in the
 * header mirrors the row's chip so the state carries into the detail view.
 */

// ABS PlayMethod enum (see server's PlayerHandler) — mapped to human labels.
const PLAY_METHOD_LABELS: Record<number, string> = {
  0: "Direct Play",
  1: "Direct Stream",
  2: "Transcode",
  3: "Local",
};

function MetaRow({
  label,
  value,
  mono,
  colors,
}: {
  label: string;
  value: string;
  mono?: boolean;
  colors: any;
}) {
  return (
    <View style={{ paddingVertical: 8 }}>
      <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, fontWeight: "600", letterSpacing: 0.3 }}>
        {label}
      </Text>
      <Text
        selectable={mono}
        style={{
          color: colors.onSurface,
          fontSize: 15,
          marginTop: 2,
          fontFamily: mono ? "monospace" : undefined,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export default function SessionDetailSheet({
  session,
  isOpen,
  onClose,
}: {
  session: AbsListeningSession | null;
  isOpen?: boolean;
  onClose: () => void;
}) {
  const colors = useThemeColors();
  // Retain the session being shown so the content survives the exit animation
  // after the parent clears `session` on close (OpenFeedSheet idiom).
  const [shown, setShown] = useState<AbsListeningSession | null>(session);
  useEffect(() => {
    if (session) setShown(session);
  }, [session]);

  const s = session || shown;

  const device =
    s?.mediaPlayer || s?.deviceInfo?.deviceName || s?.deviceInfo?.clientName || "Unknown device";
  const clientName = s?.deviceInfo?.clientName;
  const clientVersion = s?.deviceInfo?.clientVersion;
  const clientLine = clientName
    ? clientVersion
      ? `${clientName} ${clientVersion}`
      : clientName
    : "Unknown";
  // Keep the row for any numeric playMethod — an unmapped (newer-server) value
  // shows "Unknown (N)" rather than vanishing, so it's still visible for debugging.
  const playMethod =
    typeof s?.playMethod === "number"
      ? PLAY_METHOD_LABELS[s.playMethod] ?? `Unknown (${s.playMethod})`
      : undefined;

  return (
    <BottomSheet visible={!!session} onClose={onClose}>
      {s ? (
        <View style={{ paddingHorizontal: 24, paddingTop: 4, paddingBottom: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text
                accessibilityRole="header"
                style={{ color: colors.onSurface, fontSize: 19, fontWeight: "600" }}
                numberOfLines={3}
              >
                {s.displayTitle || "Unknown item"}
              </Text>
              {s.displayAuthor ? (
                <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, marginTop: 4 }} numberOfLines={2}>
                  {s.displayAuthor}
                </Text>
              ) : null}
            </View>
            {isOpen ? <StatusChip label="Open" tone="success" dot /> : null}
          </View>

          <View style={{ marginTop: 14 }}>
            <MetaRow label="User" value={s.user?.username || "Unknown user"} colors={colors} />
            <MetaRow label="Device" value={device} colors={colors} />
            <MetaRow label="Client" value={clientLine} colors={colors} />
            {playMethod ? <MetaRow label="Play method" value={playMethod} colors={colors} /> : null}
            <MetaRow
              label="Listening time"
              value={formatListeningTime(s.timeListening)}
              colors={colors}
            />
            <MetaRow
              label="Progress"
              value={`${formatListeningTime(s.currentTime)} of ${formatListeningTime(s.duration)}`}
              colors={colors}
            />
            <MetaRow
              label="Started"
              value={formatDateTime(s.startedAt, { locale: "en-US", fallback: "Unknown" })}
              colors={colors}
            />
            <MetaRow
              label="Updated"
              value={formatDateTime(s.updatedAt, { locale: "en-US", fallback: "Unknown" })}
              colors={colors}
            />
            <MetaRow label="Library item ID" value={s.libraryItemId || "—"} mono colors={colors} />
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

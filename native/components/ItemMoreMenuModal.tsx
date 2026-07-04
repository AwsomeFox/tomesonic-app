import React from "react";
import { View, Text, Pressable, Modal } from "react-native";
import { useThemeColors } from "../theme/useThemeColors";
import Icon, { IconName } from "./Icon";
import { useDownloadStore } from "../store/useDownloadStore";
import { downloader } from "../utils/downloader";
import { api } from "../utils/api";

/**
 * Bottom-sheet "more" menu for the item detail page (mirrors ItemMoreMenuModal.vue):
 * Download / Remove download, Mark (Not) Finished. Calls onChanged after an action
 * so the detail page can refetch progress.
 */
export default function ItemMoreMenuModal({
  visible,
  onClose,
  item,
  serverAddress,
  token,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  item: any;
  serverAddress: string;
  token: string;
  onChanged?: () => void;
}) {
  const colors = useThemeColors();
  const completed = useDownloadStore((s) => s.completedDownloads);
  const active = useDownloadStore((s) => s.activeDownloads);
  const cancelDownload = useDownloadStore((s) => s.cancelDownload);

  if (!item) return null;
  const id = item.id;
  const isDownloaded = !!completed[id];
  const isDownloading = !!active[id];
  const isFinished = !!item?.userMediaProgress?.isFinished;

  const rows: { icon: IconName; label: string; onPress: () => void; danger?: boolean }[] = [];

  if (isDownloaded) {
    rows.push({
      icon: "trash",
      label: "Remove Download",
      danger: true,
      onPress: () => {
        cancelDownload(id);
        onClose();
        onChanged?.();
      },
    });
  } else {
    rows.push({
      icon: "download",
      label: isDownloading ? "Downloading…" : "Download",
      onPress: async () => {
        onClose();
        if (isDownloading) return;
        try {
          await downloader.downloadBook(item, serverAddress, token);
          onChanged?.();
        } catch (e) {
          console.warn("[ItemMenu] download failed", e);
        }
      },
    });
  }

  rows.push({
    icon: "check",
    label: isFinished ? "Mark as Not Finished" : "Mark as Finished",
    onPress: async () => {
      onClose();
      try {
        await api.patch(`/api/me/progress/${id}`, { isFinished: !isFinished });
        onChanged?.();
      } catch (e) {
        console.warn("[ItemMenu] toggle finished failed", e);
      }
    },
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
        onPress={onClose}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surfaceContainerHigh,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingBottom: 28,
          }}
        >
          <View style={{ alignItems: "center", paddingVertical: 10 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.outlineVariant }} />
          </View>
          {rows.map((r, i) => (
            <Pressable
              key={i}
              onPress={r.onPress}
              android_ripple={{ color: colors.surfaceContainerHighest }}
              style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 24, paddingVertical: 16 }}
            >
              <Icon name={r.icon} size={22} color={r.danger ? colors.error : colors.onSurface} />
              <Text style={{ color: r.danger ? colors.error : colors.onSurface, fontSize: 16, marginLeft: 20 }}>
                {r.label}
              </Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

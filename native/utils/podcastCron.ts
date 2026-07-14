/**
 * Friendly cron presets for a podcast's auto-download schedule (label → 5-field
 * cron). Shared by PodcastSettingsScreen (edit) and PodcastFeedPreviewScreen
 * (create) so the two schedule pickers can't drift apart. PodcastSettings also
 * surfaces the raw cron string in an editable field, so an admin can enter a
 * custom schedule beyond these presets there; the create flow offers the
 * presets only.
 */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily", cron: "0 3 * * *" },
  { label: "Weekly", cron: "0 3 * * 0" },
];

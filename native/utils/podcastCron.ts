/**
 * Friendly cron presets for a podcast's auto-download schedule (label → 5-field
 * cron). Shared by PodcastSettingsScreen (edit) and PodcastFeedPreviewScreen
 * (create) so the two schedule pickers can't drift apart. The raw cron value
 * stays visible and editable in the UI, so an admin can still enter any custom
 * schedule beyond these presets.
 */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily", cron: "0 3 * * *" },
  { label: "Weekly", cron: "0 3 * * 0" },
];

<template>
  <div class="search-card-shell">
    <div class="search-card-icon">
      <span class="material-symbols fill text-2xl text-on-surface-variant">sell</span>
    </div>
    <div class="search-card-content tagSearchCardContent h-full">
      <p class="truncate text-base text-on-surface font-medium search-primary">{{ tag }}</p>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    tag: String
  },
  data() {
    return {}
  },
  computed: {},
  methods: {},
  mounted() {}
}
</script>

<style scoped>
.search-card-shell {
  position: relative;
  isolation: isolate;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  overflow: hidden;
  border-radius: 16px;
  background: rgb(var(--md-sys-color-surface-container));
  border: 1px solid rgba(var(--md-sys-color-outline-variant), 0.35);
  box-shadow: var(--md-sys-elevation-level1);
}

.search-card-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  background: linear-gradient(120deg, rgba(var(--md-sys-color-surface-container), 0.72), rgba(var(--md-sys-color-surface-container-high), 0.64));
  backdrop-filter: blur(8px) brightness(0.98) saturate(0.92);
  -webkit-backdrop-filter: blur(8px) brightness(0.98) saturate(0.92);
}

.search-card-shell > * {
  position: relative;
  z-index: 1;
}

.search-card-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgba(var(--md-sys-color-surface-variant), 0.6);
  flex-shrink: 0;
  box-shadow: 0 0 12px rgba(var(--md-sys-color-on-surface), 0.08);
}

.search-card-content {
  flex: 1;
  min-width: 0;
}

.tagSearchCardContent {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.search-primary {
  color: rgb(var(--md-sys-color-on-media)) !important;
  display: block;
  max-width: 100%;
  padding-left: 14px;
  padding-right: 14px;
  margin-left: -11px;
  margin-right: -11px;
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.96)) drop-shadow(0 0 5px rgba(0, 0, 0, 0.84)) drop-shadow(0 0 9px rgba(0, 0, 0, 0.72));
}
</style>

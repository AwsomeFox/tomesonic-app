<template>
  <div class="m3-loading-indicator inline-flex flex-col items-center justify-center" :style="containerStyle">
    <svg class="m3-progress" :width="size" :height="size" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle class="m3-progress__track" cx="24" cy="24" r="20" fill="none" />
      <circle class="m3-progress__indicator" cx="24" cy="24" r="20" fill="none" />
    </svg>
    <div v-if="text" class="m3-loading-indicator__label mt-3 text-sm text-on-surface-variant text-center font-medium">{{ text }}</div>
  </div>
</template>

<script>
export default {
  props: {
    text: {
      type: String,
      default: ''
    },
    size: {
      type: [Number, String],
      default: 48
    }
  },
  computed: {
    containerStyle() {
      return {}
    }
  }
}
</script>

<style scoped>
.m3-loading-indicator {
  color: rgb(var(--md-sys-color-primary));
}
.m3-progress {
  animation: m3-progress-rotate 1.4s linear infinite;
  transform-origin: center;
}
.m3-progress__track {
  stroke: rgb(var(--md-sys-color-surface-variant));
  stroke-width: 4;
  opacity: 0.4;
}
.m3-progress__indicator {
  stroke: currentColor;
  stroke-width: 4;
  stroke-linecap: round;
  stroke-dasharray: 125;
  stroke-dashoffset: 125;
  transform-origin: center;
  animation: m3-progress-dash 1.4s ease-in-out infinite;
}

@keyframes m3-progress-rotate {
  to {
    transform: rotate(360deg);
  }
}
@keyframes m3-progress-dash {
  0% {
    stroke-dasharray: 1, 125;
    stroke-dashoffset: 0;
  }
  50% {
    stroke-dasharray: 90, 125;
    stroke-dashoffset: -30;
  }
  100% {
    stroke-dasharray: 90, 125;
    stroke-dashoffset: -120;
  }
}
</style>

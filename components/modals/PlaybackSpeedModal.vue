<template>
  <modals-modal v-model="show" @input="modalInput" :width="200" height="100%">
    <template #outer>
      <div class="absolute top-4 left-4 z-40 pt-1 px-4 py-2 rounded-full bg-surface backdrop-blur-md shadow-elevation-2 border border-outline-variant" style="max-width: 80%">
        <p class="text-on-surface text-lg font-medium truncate">{{ $strings.LabelPlaybackSpeed }}</p>
      </div>
    </template>

    <div class="w-full h-full overflow-hidden absolute top-0 left-0 flex items-center justify-center" @click="show = false">
      <div class="w-full overflow-x-hidden overflow-y-auto bg-surface rounded-2xl border border-outline-variant shadow-elevation-4 backdrop-blur-md" style="max-height: 75%" @click.stop>
        <ul class="w-full" role="listbox" aria-labelledby="listbox-label">
          <template v-for="rate in rates">
            <li :key="rate" class="text-on-surface select-none relative py-4 cursor-pointer hover:bg-surface-container transition-colors duration-200" :class="rate === selected ? 'bg-primary-container text-on-primary-container' : ''" role="option" @click="clickedOption(rate)">
              <div class="flex items-center justify-center">
                <span class="font-normal block truncate text-lg">{{ rate }}x</span>
              </div>
            </li>
          </template>
        </ul>
        <div class="flex items-center justify-center py-3 border-t border-outline-variant">
          <button :disabled="!canDecrement" @click="decrement" class="w-8 h-8 text-on-surface-variant rounded border border-outline-variant flex items-center justify-center hover:bg-surface-container transition-colors duration-200 disabled:opacity-50">
            <span class="material-symbols text-on-surface">remove</span>
          </button>
          <div class="w-24 text-center">
            <p class="text-xl text-on-surface">{{ playbackRate }}<span class="text-lg">⨯</span></p>
          </div>
          <button :disabled="!canIncrement" @click="increment" class="w-8 h-8 text-on-surface-variant rounded border border-outline-variant flex items-center justify-center hover:bg-surface-container transition-colors duration-200 disabled:opacity-50">
            <span class="material-symbols text-on-surface">add</span>
          </button>
        </div>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean,
    playbackRate: Number
  },
  data() {
    return {
      currentPlaybackRate: 0,
      MIN_SPEED: 0.5,
      MAX_SPEED: 10
    }
  },
  watch: {
    show(newVal) {
      if (newVal) {
        this.currentPlaybackRate = this.selected
      }
    }
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(val) {
        this.$emit('input', val)
      }
    },
    selected: {
      get() {
        return this.playbackRate
      },
      set(val) {
        this.$emit('update:playbackRate', val)
      }
    },
    rates() {
      return [0.5, 1, 1.2, 1.5, 1.7, 2, 3]
    },
    canIncrement() {
      return this.playbackRate + 0.1 <= this.MAX_SPEED
    },
    canDecrement() {
      return this.playbackRate - 0.1 >= this.MIN_SPEED
    }
  },
  methods: {
    increment() {
      if (this.selected + 0.1 > this.MAX_SPEED) return
      var newPlaybackRate = this.selected + 0.1
      this.selected = Number(newPlaybackRate.toFixed(1))
    },
    decrement() {
      if (this.selected - 0.1 < this.MIN_SPEED) return
      var newPlaybackRate = this.selected - 0.1
      this.selected = Number(newPlaybackRate.toFixed(1))
    },
    modalInput(val) {
      if (!val) {
        if (this.currentPlaybackRate !== this.selected) {
          this.$emit('change', this.selected)
        }
      }
    },
    clickedOption(rate) {
      this.selected = Number(rate)
      this.show = false
      this.$emit('change', Number(rate))
    }
  },
  mounted() {}
}
</script>

<style>
button.icon-num-btn:disabled {
  cursor: not-allowed;
}
button.icon-num-btn:disabled::before {
  background-color: rgb(var(--md-sys-color-surface-variant) / 0.3);
}
button.icon-num-btn:disabled span {
  color: rgb(var(--md-sys-color-on-surface-variant));
}
</style>

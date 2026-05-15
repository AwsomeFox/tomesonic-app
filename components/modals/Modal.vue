<template>
  <div ref="wrapper" class="modal modal-bg w-full h-full max-h-screen fixed top-0 left-0 bg-black bg-opacity-40 backdrop-blur-sm flex items-center justify-center" style="z-index: 2147483647" @click="clickBg">
    <div class="absolute top-0 left-0 w-full h-40 bg-gradient-to-b from-black to-transparent opacity-90 pointer-events-none" />

    <slot name="outer" />
    <div ref="content" style="min-height: 200px; transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)" class="relative text-on-surface max-h-screen" :style="{ height: modalHeight, width: modalWidth, maxWidth: maxWidth, transform: contentTransform }" @click="onContentClick">
      <slot />
    </div>
  </div>
</template>

<script>
export default {
  props: {
    value: Boolean,
    processing: Boolean,
    persistent: {
      type: Boolean,
      default: true
    },
    width: {
      type: [String, Number],
      default: 500
    },
    height: {
      type: [String, Number],
      default: 'unset'
    },
    maxWidth: {
      type: String,
      default: '90%'
    }
  },
  data() {
    return {
      el: null,
      content: null,
      isVisible: false,
      isAnimating: false,
      internalTransform: 'scale(0)'
    }
  },
  watch: {
    show(newVal) {
      if (newVal) {
        this.setShow()
      } else {
        this.setHide()
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
    modalHeight() {
      if (typeof this.height === 'string') {
        return this.height
      } else {
        return this.height + 'px'
      }
    },
    modalWidth() {
      return typeof this.width === 'string' ? this.width : this.width + 'px'
    },
    contentTransform() {
      return this.internalTransform
    }
  },
  methods: {
    clickBg(ev) {
      if (this.processing && this.persistent) return
      // Only treat clicks on the outer wrapper itself (the dim area
      // around the modal content) as background dismiss. Clicks inside
      // the content area are handled by onContentClick.
      if (ev.target === this.$refs.wrapper) {
        this.show = false
      }
    },
    onContentClick(ev) {
      if (this.processing && this.persistent) return
      // Modals often wrap their visible card in a `[data-modal-backdrop]`
      // spacer that fills the slot. A click that lands *directly* on that
      // spacer (not on the card or its children) is an outside-the-card
      // click and should dismiss. Card clicks fire on the card element
      // itself and never match the attribute on this exact element.
      const target = ev.target
      if (target && target.nodeType === 1 && target.hasAttribute && target.hasAttribute('data-modal-backdrop')) {
        this.show = false
      }
    },
    setShow() {
      if (this.isVisible || this.isAnimating) return

      this.isAnimating = true
      this.$store.commit('globals/setIsModalOpen', true)

      // Move modal to document body to ensure it appears above all content
      document.body.appendChild(this.el)

      // Use requestAnimationFrame for reliable timing
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.internalTransform = 'scale(1)'
          setTimeout(() => {
            this.isVisible = true
            this.isAnimating = false
          }, 250) // Match transition duration
        })
      })
      document.documentElement.classList.add('modal-open')
    },
    setHide() {
      if (!this.isVisible && !this.isAnimating) return

      this.isAnimating = true
      this.isVisible = false
      this.$store.commit('globals/setIsModalOpen', false)

      this.internalTransform = 'scale(0)'

      // Listen for transition end instead of fixed timeout
      const handleTransitionEnd = () => {
        // Remove modal from document body and hide it
        if (this.el.parentNode) {
          this.el.parentNode.removeChild(this.el)
        }
        this.isAnimating = false
        this.content.removeEventListener('transitionend', handleTransitionEnd)
      }
      this.content.addEventListener('transitionend', handleTransitionEnd)

      // Fallback timeout in case transitionend doesn't fire
      setTimeout(() => {
        if (this.isAnimating) {
          if (this.el.parentNode) {
            this.el.parentNode.removeChild(this.el)
          }
          this.isAnimating = false
          this.content.removeEventListener('transitionend', handleTransitionEnd)
        }
      }, 300)

      document.documentElement.classList.remove('modal-open')
    },
    closeModalEvt() {
      this.show = false
    }
  },
  mounted() {
    this.$eventBus.$on('close-modal', this.closeModalEvt)
    this.el = this.$refs.wrapper
    this.content = this.$refs.content

    // Remove modal from its initial position but keep it in memory
    if (this.el.parentNode) {
      this.el.parentNode.removeChild(this.el)
    }
  },
  beforeDestroy() {
    this.$eventBus.$off('close-modal', this.closeModalEvt)
  }
}
</script>

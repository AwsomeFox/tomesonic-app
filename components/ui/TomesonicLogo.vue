<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 512 512" :class="['tomesonic-logo', colorClass]">
    <defs>
      <!-- Solid colors instead of gradients -->
      <style>
        .book-left { fill: #8B5CF6; }
        .book-right { fill: #06B6D4; }
        .book-spine { fill: #6366F1; }
        .book-shadow { fill: #000000; opacity: 0.1; }
        .book-highlight { fill: #FFFFFF; opacity: 0.2; }
        .play-outline { fill: none; stroke: #FFFFFF; stroke-width: 8; stroke-linejoin: round; }
      </style>
    </defs>
    
    <!-- Book shadow -->
    <g transform="translate(6, 12) rotate(-8 256 256)">
      <path d="M80 160 L220 160 L220 420 L80 420 Q60 420 60 400 L60 180 Q60 160 80 160 Z" class="book-shadow"/>
      <path d="M220 160 L380 160 Q400 160 400 180 L400 400 Q400 420 380 420 L220 420 Z" class="book-shadow"/>
    </g>
    
    <!-- Main book angled like being held -->
    <g transform="rotate(-8 256 256)">
      <!-- Left page -->
      <path d="M80 160 L220 160 L220 420 L80 420 Q60 420 60 400 L60 180 Q60 160 80 160 Z" class="book-left"/>
      
      <!-- Right page -->
      <path d="M220 160 L380 160 Q400 160 400 180 L400 400 Q400 420 380 420 L220 420 Z" class="book-right"/>
      
      <!-- Book spine/binding -->
      <rect x="220" y="160" width="8" height="260" class="book-spine"/>
      
      <!-- Page highlights -->
      <path d="M80 160 L200 160 L200 180 L80 180 Q60 180 60 180 Z" class="book-highlight"/>
      <path d="M240 160 L380 160 Q400 160 400 180 L400 180 L240 180 Z" class="book-highlight"/>
      
      <!-- Inner page lines for depth -->
      <line x1="80" y1="200" x2="200" y2="200" stroke="white" stroke-width="1" opacity="0.3"/>
      <line x1="80" y1="220" x2="180" y2="220" stroke="white" stroke-width="1" opacity="0.2"/>
      <line x1="240" y1="200" x2="380" y2="200" stroke="white" stroke-width="1" opacity="0.3"/>
      <line x1="260" y1="220" x2="380" y2="220" stroke="white" stroke-width="1" opacity="0.2"/>
    </g>
    
    <!-- Play button - outlined rounded triangle -->
    <g transform="translate(256, 290)">
      <path d="M-20 -24 L-20 24 L20 0 Z" class="play-outline" rx="4"/>
    </g>
  </svg>
</template>

<script>
export default {
  name: 'TomesonicLogo',
  props: {
    size: {
      type: [String, Number],
      default: 24
    },
    color: {
      type: String,
      default: 'on-surface'
    }
  },
  computed: {
    colorClass() {
      return `text-${this.color}`
    }
  }
}
</script>

<style scoped>
.tomesonic-logo {
  transition: color 200ms cubic-bezier(0.2, 0, 0, 1);
}

/* Hover states for interactive logos */
.tomesonic-logo:hover {
  opacity: 0.8;
}
</style>
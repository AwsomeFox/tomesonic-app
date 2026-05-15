const pkg = require('./package.json')

export default {
  ssr: false,
  target: 'static',
  telemetry: false,
  env: {
    PROD: '1',
    ANDROID_APP_URL: 'https://play.google.com/store/apps/details?id=com.tomesonic.app',
    IOS_APP_URL: ''
  },

  publicRuntimeConfig: {
    version: pkg.version
  },

  head: {
    title: 'TomeSonic',
    htmlAttrs: {
      lang: 'en',
      class: 'm3-boot-hidden'
    },
    meta: [{ charset: 'utf-8' }, { name: 'viewport', content: 'viewport-fit=cover, width=device-width, initial-scale=1, user-scalable=no, maximum-scale=1' }, { hid: 'description', name: 'description', content: '' }, { name: 'format-detection', content: 'telephone=no' }],
    script: [
      {
        src: '/libs/sortable.js'
      }
    ],
    style: [
      {
        // Paint the Material 3 surface background immediately, before the CSS bundle
        // parses, so the WebView never flashes white between the native splash screen
        // and the Vue app rendering. The .m3-boot-hidden veil keeps the Vue layout
        // invisible until init.client.js removes the class after first paint, so the
        // user only ever sees a solid Material surface during boot (never white/black).
        hid: 'm3-bootstrap-bg',
        cssText: `html,body,#__nuxt,#__layout{background-color:rgb(255,248,250);color:rgb(32,26,29);} @media (prefers-color-scheme: dark){html,body,#__nuxt,#__layout{background-color:rgb(20,18,24);color:rgb(230,225,229);}} html.m3-boot-hidden #__layout,html.m3-boot-hidden #__nuxt>*{visibility:hidden!important;}`,
        type: 'text/css'
      }
    ],
    link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }]
  },

  css: ['@/assets/tailwind.css', '@/assets/app.css'],

  plugins: ['@/plugins/server.js', '@/plugins/db.js', '@/plugins/localStore.js', '@/plugins/dynamicColor.early.client.js', '@/plugins/init.client.js', '@/plugins/axios.js', '@/plugins/capacitor/index.js', '@/plugins/capacitor/AbsAudioPlayer.js', '@/plugins/nativeHttp.js', '@/plugins/toast.js', '@/plugins/constants.js', '@/plugins/haptics.js', '@/plugins/i18n.js'],

  components: true,

  modules: ['@nuxtjs/axios'],

  axios: {},

  build: {
    postcss: {
      postcssOptions: {
        plugins: {
          tailwindcss: {},
          autoprefixer: {}
        }
      }
    },
    babel: {
      plugins: [['@babel/plugin-proposal-private-property-in-object', { loose: true }]]
    }
  }
}

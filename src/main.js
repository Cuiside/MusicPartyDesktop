import { createApp } from 'vue'
import { createPinia } from 'pinia'

import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'

import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'

import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')

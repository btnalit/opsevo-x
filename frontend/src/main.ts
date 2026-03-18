import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles/markdown.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// Load auth state from localStorage after Pinia is initialized
import { useAuthStore } from './stores/auth'
const authStore = useAuthStore()
authStore.loadFromStorage()

app.mount('#app')

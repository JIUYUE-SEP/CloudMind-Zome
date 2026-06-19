/// <reference types="vite/client" />

declare module 'vue' {
  interface ComponentCustomProperties {
    $uploadUrl: (url: string | undefined) => string
  }
}

export {}

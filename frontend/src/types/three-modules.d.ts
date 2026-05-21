declare module 'three/examples/jsm/loaders/GLTFLoader' {
  import { Loader, Group } from 'three'
  export class GLTFLoader extends Loader {
    register(callback: (parser: any) => any): void
    load(
      url: string,
      onLoad: (gltf: any) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (event: ErrorEvent) => void
    ): void
  }
}

declare module 'three/examples/jsm/controls/OrbitControls' {
  import { Camera, EventDispatcher } from 'three'
  export class OrbitControls extends EventDispatcher {
    constructor(camera: Camera, domElement?: HTMLElement)
    target: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }
    enableDamping: boolean
    enablePan: boolean
    minDistance: number
    maxDistance: number
    maxPolarAngle: number
    update(): void
    dispose(): void
  }
}

<template>
  <div ref="container" class="vrm-viewer">
    <canvas ref="canvasRef"></canvas>
    <div v-if="loading" class="viewer-loading">加载 3D 模型...</div>
    <div v-if="error" class="viewer-error">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'

const props = defineProps<{ modelUrl: string }>()

const container = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()
const loading = ref(false)
const error = ref('')

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let currentVrm: any
let animId: number

onMounted(() => {
  initScene()
  window.addEventListener('resize', onResize)
  if (props.modelUrl) loadVRM(props.modelUrl)
})

watch(() => props.modelUrl, (url) => {
  if (url) loadVRM(url)
  else cleanupVRM()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animId)
  window.removeEventListener('resize', onResize)
  controls?.dispose()
  renderer?.dispose()
})

function initScene() {
  const el = container.value!
  const canvas = canvasRef.value!
  const w = el.clientWidth
  const h = el.clientHeight

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0b0f17)

  camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 100)
  camera.position.set(0, 1.2, 2.2)

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const dl = new THREE.DirectionalLight(0xffffff, 1.2)
  dl.position.set(1, 1, 1)
  scene.add(dl)
  scene.add(new THREE.AmbientLight(0xffffff, 0.5))

  controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0.9, 0)
  controls.enableDamping = true
  controls.enablePan = false
  controls.minDistance = 1.2
  controls.maxDistance = 4
  controls.maxPolarAngle = Math.PI / 2 + 0.2

  animate()
}

function loadVRM(url: string) {
  loading.value = true
  error.value = ''
  cleanupVRM()

  const loader = new GLTFLoader()
  loader.register((parser: any) => new VRMLoaderPlugin(parser))

  loader.load(
    url,
    (gltf: any) => {
      currentVrm = gltf.userData.vrm
      if (!currentVrm) {
        error.value = '无效的 VRM 文件'
        loading.value = false
        return
      }

      VRMUtils.removeUnnecessaryVertices(currentVrm.scene)
      VRMUtils.removeUnnecessaryJoints(currentVrm.scene)
      scene.add(currentVrm.scene)

      // Auto position
      const box = new THREE.Box3().setFromObject(currentVrm.scene)
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      camera.position.set(center.x, center.y + size.y * 0.3, center.z + maxDim * 1.8)
      controls.target.set(center.x, center.y * 0.5, center.z)

      loading.value = false
    },
    undefined,
    (err: any) => {
      console.error('VRM load error:', err)
      error.value = '模型加载失败'
      loading.value = false
    }
  )
}

function cleanupVRM() {
  if (currentVrm) {
    scene.remove(currentVrm.scene)
    VRMUtils.deepDispose(currentVrm.scene)
    currentVrm = null
  }
}

function onResize() {
  if (!container.value || !renderer) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}

function animate() {
  animId = requestAnimationFrame(animate)
  const t = performance.now() * 0.001

  if (currentVrm) {
    // Breathing idle
    const s = 1 + 0.012 * Math.sin(t * 1.5)
    currentVrm.scene.scale.set(s, s, s)
    currentVrm.update(t)
  }

  controls.update()
  renderer.render(scene, camera)
}
</script>

<style scoped>
.vrm-viewer {
  position: relative;
  width: 100%;
  height: 100%;
}
.vrm-viewer canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.viewer-loading,
.viewer-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  pointer-events: none;
}
.viewer-loading {
  color: #5a6a7a;
}
.viewer-error {
  color: #ef4444;
}
</style>

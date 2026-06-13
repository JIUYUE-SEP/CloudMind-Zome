import { createRouter, createWebHashHistory } from 'vue-router'
import AppShell from '@/views/AppShell.vue'
import HomeView from '@/views/HomeView.vue'
import ChatView from '@/components/ChatView.vue'
import GroupChatView from '@/components/GroupChatView.vue'
import CommunicationHub from '@/components/CommunicationHub.vue'

const ActionCenter = () => import('@/components/ActionCenter.vue')
const ActionEdit = () => import('@/components/ActionEdit.vue')
const AgentEdit = () => import('@/components/AgentEdit.vue')
const ComputeCenter = () => import('@/components/ComputeCenter.vue')
const CommissionCenter = () => import('@/components/CommissionCenter.vue')
const ApprovalLog = () => import('@/components/ApprovalLog.vue')
const SelfImageView = () => import('@/views/SelfImageView.vue')
const UserProfileView = () => import('@/views/UserProfileView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', component: HomeView },
      ],
    },
    { path: '/chat/:sessionId', component: ChatView, props: true },
    { path: '/group/:groupId', component: GroupChatView, props: true },
    { path: '/actions', component: ActionCenter },
    { path: '/actions/new', component: ActionEdit },
    { path: '/actions/:id/edit', component: ActionEdit, props: true },
    { path: '/agents/new', component: AgentEdit },
    { path: '/agents/:id/edit', component: AgentEdit, props: true },
    { path: '/compute', component: ComputeCenter },
    { path: '/commissions', component: CommissionCenter },
    { path: '/approvals', component: ApprovalLog },
    { path: '/communications', component: CommunicationHub },
    { path: '/self-image', component: SelfImageView },
    { path: '/user-profile', component: UserProfileView },
  ],
})

export default router

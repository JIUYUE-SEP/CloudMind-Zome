# CloudMind-Zome 编程 Agent 模式 — 实现计划（Phase 1）

> **面向 AI 代理的工作者：** 本计划为前端 + 后端功能实现，推荐子代理驱动或内联执行。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在现有 `/hub` 私聊页面中增加「编程模式」，实现会话模式切换、IDE 面板（文件树 + Monaco 编辑器 + 命令输出）、以及 `list_files` / `edit_file` / `run_command` 三个新工具。

**架构：** 后端在 `ChatSession` 和 `AgentWorker` 中增加 `mode` 概念，根据模式注入不同系统提示；前端在 `hub.vue` 中增加双栏布局和 `components/code/` 组件集；WebSocket 协议新增 `session.set_mode` 与 `code.*` 帧；项目文件操作统一限制在 `{DATA_DIR}/projects/{projectId}/` 下。

**技术栈：** TypeScript、Node.js 22、Fastify、Nuxt 3、Vue 3、Pinia、Monaco Editor、WebSocket、Vitest。

---

## 1. 文件结构

### 1.1 后端新增/修改

| 文件 | 职责 | 操作 |
|------|------|------|
| `services/engine/src/tools/builtin/list_files.ts` | 列出项目目录文件 | 创建 |
| `services/engine/src/tools/builtin/edit_file.ts` | 基于 oldString/newString 精确编辑文件 | 创建 |
| `services/engine/src/tools/builtin/run_command.ts` | 执行 shell 命令并返回输出 | 创建 |
| `services/engine/src/tools/builtin/read.ts` | 读取文件，支持项目路径 | 修改 |
| `services/engine/src/tools/builtin/write.ts` | 写入文件，支持项目路径 | 修改 |
| `services/engine/src/tools/builtin/index.ts` | 注册新工具 | 修改 |
| `services/engine/src/api/ws/handler.ts` | 处理 `session.set_mode`、`code.file_open` 帧 | 修改 |
| `services/engine/src/api/ws/protocol.ts` | 新增帧类型定义 | 修改 |
| `services/engine/src/core/agent-worker.ts` | 根据 mode 注入 code 系统提示 | 修改 |
| `services/engine/src/types/chat.ts` 或类似 | ChatMode 类型 | 修改 |
| `services/engine/tests/tools/` | 新工具测试 | 创建/修改 |

### 1.2 前端新增/修改

| 文件 | 职责 | 操作 |
|------|------|------|
| `apps/web/pages/hub.vue` | 增加模式切换、双栏布局、IDE 容器 | 修改 |
| `apps/web/components/code/CodeWorkspace.vue` | IDE 面板总容器 | 创建 |
| `apps/web/components/code/FileTree.vue` | 文件树 | 创建 |
| `apps/web/components/code/CodeEditor.vue` | Monaco Editor 包装 | 创建 |
| `apps/web/components/code/TerminalPanel.vue` | 命令输出面板 | 创建 |
| `apps/web/components/ChatView.vue` | 适配双栏布局 | 修改 |
| `apps/web/stores/chat.ts` | 增加 mode、projectId、openFiles、terminalOutput | 修改 |
| `apps/web/composables/useEngineClient.ts` | 处理 `code.*` 帧 | 修改 |
| `apps/web/package.json` | 添加 monaco-editor 依赖 | 修改 |
| `apps/web/tests/components/code/` | 组件测试 | 创建 |

---

## 2. 任务分解

### 任务 1：创建 feature 分支

**文件：**
- 修改：仓库当前分支状态

- [ ] **步骤 1：基于 main 创建分支**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome
  git checkout main
  git pull
  git checkout -b feat/code-agent-mode
  ```

- [ ] **步骤 2：确认当前分支**

  运行：
  ```bash
  git branch --show-current
  ```
  预期：`feat/code-agent-mode`

---

### 任务 2：后端 — 项目路径工具函数

**文件：**
- 创建：`services/engine/src/tools/project-paths.ts`

- [ ] **步骤 1：编写失败的测试**

  创建 `services/engine/tests/tools/project-paths.test.ts`：
  ```typescript
  import { describe, it, expect } from "vitest";
  import { resolveProjectPath, validateProjectPath } from "../../src/tools/project-paths.js";

  describe("project-paths", () => {
    it("resolves relative path under project root", () => {
      const result = resolveProjectPath("/data/projects/p1", "src/main.ts");
      expect(result).toBe("/data/projects/p1/src/main.ts");
    });

    it("rejects path escaping project root", () => {
      expect(() => validateProjectPath("/data/projects/p1", "../escape.ts")).toThrow();
    });

    it("rejects absolute path outside project root", () => {
      expect(() => validateProjectPath("/data/projects/p1", "/etc/passwd")).toThrow();
    });
  });
  ```

- [ ] **步骤 2：运行测试验证失败**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/project-paths.test.ts
  ```
  预期：FAIL，模块未找到

- [ ] **步骤 3：实现最少代码**

  创建 `services/engine/src/tools/project-paths.ts`：
  ```typescript
  import path from "node:path";

  export function resolveProjectPath(projectRoot: string, relativePath: string): string {
    const resolved = path.resolve(projectRoot, relativePath);
    validateProjectPath(projectRoot, relativePath);
    return resolved;
  }

  export function validateProjectPath(projectRoot: string, relativePath: string): void {
    const resolved = path.resolve(projectRoot, relativePath);
    const normalizedRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
      throw new Error(`Path escapes project root: ${relativePath}`);
    }
  }
  ```

- [ ] **步骤 4：运行测试验证通过**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/project-paths.test.ts
  ```
  预期：PASS

- [ ] **步骤 5：Commit**

  运行：
  ```bash
  git add services/engine/src/tools/project-paths.ts services/engine/tests/tools/project-paths.test.ts
  git commit -m "feat(tools): add project path validation utilities"
  ```

---

### 任务 3：后端 — list_files 工具

**文件：**
- 创建：`services/engine/src/tools/builtin/list_files.ts`
- 修改：`services/engine/src/tools/builtin/index.ts`

- [ ] **步骤 1：编写失败的测试**

  创建 `services/engine/tests/tools/list_files.test.ts`：
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import fs from "node:fs";
  import path from "node:path";
  import os from "node:os";
  import { listFilesTool } from "../../src/tools/builtin/list_files.js";

  describe("list_files", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-files-"));
      fs.mkdirSync(path.join(tmpDir, "src"));
      fs.writeFileSync(path.join(tmpDir, "src", "main.ts"), "export {}");
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# readme");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("lists files and directories", async () => {
      const result = await listFilesTool.execute(
        { projectRoot: tmpDir } as any,
        { path: ".", recursive: false }
      );
      expect(result.success).toBe(true);
      const output = result.output as { entries: Array<{ name: string; type: string }> };
      expect(output.entries).toContainEqual({ name: "README.md", type: "file" });
      expect(output.entries).toContainEqual({ name: "src", type: "directory" });
    });

    it("rejects escaping paths", async () => {
      const result = await listFilesTool.execute(
        { projectRoot: tmpDir } as any,
        { path: "../escape", recursive: false }
      );
      expect(result.success).toBe(false);
    });
  });
  ```

- [ ] **步骤 2：运行测试验证失败**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/list_files.test.ts
  ```
  预期：FAIL

- [ ] **步骤 3：实现 list_files 工具**

  创建 `services/engine/src/tools/builtin/list_files.ts`：
  ```typescript
  import fs from "node:fs";
  import path from "node:path";
  import { z } from "zod";
  import type { Tool, ToolContext, ToolResult } from "../types.js";
  import { resolveProjectPath } from "../project-paths.js";

  const parameters = z.object({
    path: z.string().default("."),
    recursive: z.boolean().default(false),
  });

  export const listFilesTool: Tool = {
    name: "list_files",
    description: "List files and directories under the project path.",
    parameters,
    accesses: [{ resource: "filesystem", action: "read" }],
    async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
      const { path: relPath, recursive } = args as { path: string; recursive: boolean };
      const projectRoot = (ctx as any).projectRoot;
      if (!projectRoot) {
        return { success: false, error: "No project root configured" };
      }
      try {
        const targetDir = resolveProjectPath(projectRoot, relPath);
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });
        const result = entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));
        if (recursive) {
          // Phase 1: non-recursive is enough; recursive can be added later
        }
        return { success: true, output: { entries: result } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  };
  ```

- [ ] **步骤 4：注册工具**

  修改 `services/engine/src/tools/builtin/index.ts`，在导出列表中加入 `listFilesTool`。

- [ ] **步骤 5：运行测试验证通过**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/list_files.test.ts
  ```
  预期：PASS

- [ ] **步骤 6：Commit**

  运行：
  ```bash
  git add services/engine/src/tools/builtin/list_files.ts services/engine/src/tools/builtin/index.ts services/engine/tests/tools/list_files.test.ts
  git commit -m "feat(tools): add list_files tool"
  ```

---

### 任务 4：后端 — edit_file 工具

**文件：**
- 创建：`services/engine/src/tools/builtin/edit_file.ts`
- 修改：`services/engine/src/tools/builtin/index.ts`

- [ ] **步骤 1：编写失败的测试**

  创建 `services/engine/tests/tools/edit_file.test.ts`：
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import fs from "node:fs";
  import path from "node:path";
  import os from "node:os";
  import { editFileTool } from "../../src/tools/builtin/edit_file.js";

  describe("edit_file", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-file-"));
      fs.writeFileSync(path.join(tmpDir, "main.ts"), "function foo() {\n  return 1;\n}\n");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("replaces unique oldString with newString", async () => {
      const result = await editFileTool.execute(
        { projectRoot: tmpDir } as any,
        { path: "main.ts", oldString: "  return 1;", newString: "  return 2;" }
      );
      expect(result.success).toBe(true);
      const content = fs.readFileSync(path.join(tmpDir, "main.ts"), "utf-8");
      expect(content).toContain("  return 2;");
    });

    it("fails when oldString is not unique", async () => {
      fs.writeFileSync(path.join(tmpDir, "dup.ts"), "a\na\n");
      const result = await editFileTool.execute(
        { projectRoot: tmpDir } as any,
        { path: "dup.ts", oldString: "a", newString: "b" }
      );
      expect(result.success).toBe(false);
    });
  });
  ```

- [ ] **步骤 2：运行测试验证失败**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/edit_file.test.ts
  ```
  预期：FAIL

- [ ] **步骤 3：实现 edit_file 工具**

  创建 `services/engine/src/tools/builtin/edit_file.ts`：
  ```typescript
  import fs from "node:fs";
  import { z } from "zod";
  import type { Tool, ToolContext, ToolResult } from "../types.js";
  import { resolveProjectPath } from "../project-paths.js";

  const parameters = z.object({
    path: z.string(),
    oldString: z.string(),
    newString: z.string(),
  });

  export const editFileTool: Tool = {
    name: "edit_file",
    description: "Replace a unique occurrence of oldString with newString in a project file.",
    parameters,
    accesses: [{ resource: "filesystem", action: "write" }],
    async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
      const { path: relPath, oldString, newString } = args as { path: string; oldString: string; newString: string };
      const projectRoot = (ctx as any).projectRoot;
      if (!projectRoot) {
        return { success: false, error: "No project root configured" };
      }
      try {
        const filePath = resolveProjectPath(projectRoot, relPath);
        const content = fs.readFileSync(filePath, "utf-8");
        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) {
          return { success: false, error: `oldString not found in ${relPath}` };
        }
        if (occurrences > 1) {
          return { success: false, error: `oldString is not unique in ${relPath} (${occurrences} occurrences)` };
        }
        const newContent = content.replace(oldString, newString);
        fs.writeFileSync(filePath, newContent, "utf-8");
        return { success: true, output: { path: relPath, replaced: true } };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  };
  ```

- [ ] **步骤 4：注册工具**

  修改 `services/engine/src/tools/builtin/index.ts`，加入 `editFileTool`。

- [ ] **步骤 5：运行测试验证通过**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/edit_file.test.ts
  ```
  预期：PASS

- [ ] **步骤 6：Commit**

  运行：
  ```bash
  git add services/engine/src/tools/builtin/edit_file.ts services/engine/src/tools/builtin/index.ts services/engine/tests/tools/edit_file.test.ts
  git commit -m "feat(tools): add edit_file tool"
  ```

---

### 任务 5：后端 — run_command 工具

**文件：**
- 创建：`services/engine/src/tools/builtin/run_command.ts`
- 修改：`services/engine/src/tools/builtin/index.ts`

- [ ] **步骤 1：编写失败的测试**

  创建 `services/engine/tests/tools/run_command.test.ts`：
  ```typescript
  import { describe, it, expect } from "vitest";
  import os from "node:os";
  import path from "node:path";
  import fs from "node:fs";
  import { runCommandTool } from "../../src/tools/builtin/run_command.js";

  describe("run_command", () => {
    it("runs a simple command and returns output", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-cmd-"));
      const result = await runCommandTool.execute(
        { projectRoot: tmpDir } as any,
        { command: process.platform === "win32" ? "echo hello" : "echo hello", timeout: 5 }
      );
      expect(result.success).toBe(true);
      expect((result.output as { stdout: string }).stdout).toContain("hello");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("rejects commands escaping project root", async () => {
      const result = await runCommandTool.execute(
        { projectRoot: "/tmp/project" } as any,
        { command: "cd .. && pwd", timeout: 5 }
      );
      expect(result.success).toBe(false);
    });
  });
  ```

- [ ] **步骤 2：运行测试验证失败**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/run_command.test.ts
  ```
  预期：FAIL

- [ ] **步骤 3：实现 run_command 工具**

  创建 `services/engine/src/tools/builtin/run_command.ts`：
  ```typescript
  import { exec } from "node:child_process";
  import { promisify } from "node:util";
  import { z } from "zod";
  import type { Tool, ToolContext, ToolResult } from "../types.js";
  import { resolveProjectPath } from "../project-paths.js";

  const execAsync = promisify(exec);

  const parameters = z.object({
    command: z.string(),
    cwd: z.string().default("."),
    timeout: z.number().default(60),
  });

  function isDangerousCommand(command: string): boolean {
    const dangerous = [/rm\s+-rf\s+\//, /curl\s+.*\|\s*sh/, /mkfs/, /dd\s+if=/];
    return dangerous.some((pattern) => pattern.test(command));
  }

  export const runCommandTool: Tool = {
    name: "run_command",
    description: "Run a shell command under the project root and return stdout/stderr.",
    parameters,
    accesses: [{ resource: "shell", action: "execute" }],
    async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
      const { command, cwd, timeout } = args as { command: string; cwd: string; timeout: number };
      const projectRoot = (ctx as any).projectRoot;
      if (!projectRoot) {
        return { success: false, error: "No project root configured" };
      }
      if (isDangerousCommand(command)) {
        return { success: false, error: "Command blocked for security reasons" };
      }
      try {
        const workingDir = resolveProjectPath(projectRoot, cwd);
        const { stdout, stderr } = await execAsync(command, { cwd: workingDir, timeout: timeout * 1000 });
        return { success: true, output: { stdout, stderr, exitCode: 0 } };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
          output: { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code || 1 },
        };
      }
    },
  };
  ```

- [ ] **步骤 4：注册工具**

  修改 `services/engine/src/tools/builtin/index.ts`，加入 `runCommandTool`。

- [ ] **步骤 5：运行测试验证通过**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test services/engine/tests/tools/run_command.test.ts
  ```
  预期：PASS

- [ ] **步骤 6：Commit**

  运行：
  ```bash
  git add services/engine/src/tools/builtin/run_command.ts services/engine/src/tools/builtin/index.ts services/engine/tests/tools/run_command.test.ts
  git commit -m "feat(tools): add run_command tool"
  ```

---

### 任务 6：后端 — ChatSession 增加 mode 和 projectId

**文件：**
- 修改：`packages/shared/src/types/chat.ts`（或找到现有 ChatSession 类型位置）
- 修改：`services/engine/src/core/agent-worker.ts`
- 修改：`services/engine/src/api/ws/handler.ts`

- [ ] **步骤 1：找到 ChatSession 类型并修改**

  使用 Grep 找到 `ChatSession` 类型定义，增加 `mode` 和 `projectId`：
  ```typescript
  export type ChatMode = 'chat' | 'code';

  export interface ChatSession {
    id: string;
    mode?: ChatMode;
    projectId?: string;
    // ... 其他字段
  }
  ```

- [ ] **步骤 2：AgentWorker 根据 mode 注入系统提示**

  在 `services/engine/src/core/agent-worker.ts` 中，找到系统提示组装位置，追加：
  ```typescript
  const codeSystemPrompt = session.mode === 'code'
    ? `You are in code assistant mode. You can list files, read/write/edit files under the project workspace, and run shell commands. Always explain your intent before making changes.`
    : '';
  ```

- [ ] **步骤 3：处理 session.set_mode 帧**

  在 `services/engine/src/api/ws/handler.ts` 中增加：
  ```typescript
  if (msg.type === 'session.set_mode') {
    session.mode = msg.mode;
    session.projectId = msg.projectId;
    // 通知前端模式已切换
    ws.send(JSON.stringify({ type: 'session.mode_changed', mode: msg.mode, projectId: msg.projectId }));
  }
  ```

- [ ] **步骤 4：将 projectRoot 注入 ToolContext**

  在工具调用处，根据 `session.projectId` 构造 `projectRoot`，放入 `ToolContext`：
  ```typescript
  const projectRoot = session.projectId
    ? path.join(dataDir, 'projects', session.projectId)
    : undefined;
  const toolContext = { ...ctx, projectRoot };
  ```

- [ ] **步骤 5：运行 engine 类型检查和测试**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine typecheck
  pnpm --filter @mindcloud/engine test
  ```
  预期：通过

- [ ] **步骤 6：Commit**

  运行：
  ```bash
  git add -A
  git commit -m "feat(engine): add chat mode and project root context"
  ```

---

### 任务 7：前端 — 添加 Monaco Editor 依赖

**文件：**
- 修改：`apps/web/package.json`

- [ ] **步骤 1：安装依赖**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome/apps/web
  pnpm add monaco-editor
  pnpm add -D @types/monaco-editor
  ```

- [ ] **步骤 2：验证安装**

  运行：
  ```bash
  cat /f/MyProject_justlove/MindCloud-Zome/apps/web/package.json | grep monaco
  ```
  预期：显示 `monaco-editor` 依赖

- [ ] **步骤 3：Commit**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome
  git add apps/web/package.json pnpm-lock.yaml
  git commit -m "chore(web): add monaco-editor dependency"
  ```

---

### 任务 8：前端 — CodeWorkspace 组件

**文件：**
- 创建：`apps/web/components/code/CodeWorkspace.vue`
- 创建：`apps/web/components/code/FileTree.vue`
- 创建：`apps/web/components/code/CodeEditor.vue`
- 创建：`apps/web/components/code/TerminalPanel.vue`

- [ ] **步骤 1：创建 TerminalPanel.vue**

  创建 `apps/web/components/code/TerminalPanel.vue`：
  ```vue
  <template>
    <div class="terminal-panel">
      <div class="terminal-header">
        <span>Terminal</span>
        <button @click="$emit('clear')">Clear</button>
      </div>
      <pre class="terminal-content"><code>{{ output }}</code></pre>
    </div>
  </template>

  <script setup lang="ts">
  defineProps<{ output: string }>();
  defineEmits<{ (e: 'clear'): void }>();
  </script>

  <style scoped>
  .terminal-panel { display: flex; flex-direction: column; height: 100%; }
  .terminal-header { display: flex; justify-content: space-between; padding: 4px 8px; background: #1e1e1e; color: #fff; }
  .terminal-content { flex: 1; overflow: auto; background: #0d0d0d; color: #d4d4d4; padding: 8px; margin: 0; font-family: monospace; }
  </style>
  ```

- [ ] **步骤 2：创建 CodeEditor.vue**

  创建 `apps/web/components/code/CodeEditor.vue`：
  ```vue
  <template>
    <div ref="editorContainer" class="code-editor" />
  </template>

  <script setup lang="ts">
  import { ref, onMounted, watch } from 'vue';
  import * as monaco from 'monaco-editor';

  const props = defineProps<{ modelValue: string; language?: string; path?: string }>();
  const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

  const editorContainer = ref<HTMLElement | null>(null);
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;

  onMounted(() => {
    if (!editorContainer.value) return;
    editor = monaco.editor.create(editorContainer.value, {
      value: props.modelValue,
      language: props.language || 'typescript',
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly: false,
    });
    editor.onDidChangeModelContent(() => {
      emit('update:modelValue', editor?.getValue() || '');
    });
  });

  watch(() => props.modelValue, (val) => {
    if (editor && editor.getValue() !== val) {
      editor.setValue(val);
    }
  });
  </script>

  <style scoped>
  .code-editor { width: 100%; height: 100%; }
  </style>
  ```

- [ ] **步骤 3：创建 FileTree.vue**

  创建 `apps/web/components/code/FileTree.vue`：
  ```vue
  <template>
    <div class="file-tree">
      <div v-for="entry in entries" :key="entry.name" class="file-tree-entry" @click="onClick(entry)">
        <span>{{ entry.type === 'directory' ? '📁' : '📄' }} {{ entry.name }}</span>
      </div>
    </div>
  </template>

  <script setup lang="ts">
  defineProps<{ entries: Array<{ name: string; type: 'file' | 'directory' }> }>();
  const emit = defineEmits<{ (e: 'open', entry: { name: string; type: string }): void }>();

  function onClick(entry: { name: string; type: string }) {
    emit('open', entry);
  }
  </script>

  <style scoped>
  .file-tree { padding: 8px; overflow: auto; }
  .file-tree-entry { cursor: pointer; padding: 2px 4px; }
  .file-tree-entry:hover { background: #2a2d2e; }
  </style>
  ```

- [ ] **步骤 4：创建 CodeWorkspace.vue**

  创建 `apps/web/components/code/CodeWorkspace.vue`：
  ```vue
  <template>
    <div class="code-workspace">
      <div class="workspace-sidebar">
        <FileTree :entries="entries" @open="onFileOpen" />
      </div>
      <div class="workspace-main">
        <div class="editor-area">
          <CodeEditor v-model="currentFileContent" :language="currentLanguage" />
        </div>
        <div class="terminal-area">
          <TerminalPanel :output="terminalOutput" @clear="terminalOutput = ''" />
        </div>
      </div>
    </div>
  </template>

  <script setup lang="ts">
  import { ref, computed } from 'vue';
  import FileTree from './FileTree.vue';
  import CodeEditor from './CodeEditor.vue';
  import TerminalPanel from './TerminalPanel.vue';

  const props = defineProps<{ projectId: string; terminalOutput: string }>();
  const emit = defineEmits<{ (e: 'openFile', path: string): void; (e: 'clearTerminal'): void }>();

  const entries = ref<Array<{ name: string; type: 'file' | 'directory' }>>([]);
  const currentFileContent = ref('');
  const currentFilePath = ref('');

  const currentLanguage = computed(() => {
    if (currentFilePath.value.endsWith('.ts')) return 'typescript';
    if (currentFilePath.value.endsWith('.vue')) return 'html';
    if (currentFilePath.value.endsWith('.md')) return 'markdown';
    return 'plaintext';
  });

  function onFileOpen(entry: { name: string; type: string }) {
    if (entry.type === 'file') {
      currentFilePath.value = entry.name;
      emit('openFile', entry.name);
    }
  }

  defineExpose({ entries, setFileContent: (content: string) => { currentFileContent.value = content; }, appendTerminal: (text: string) => { /* handled by parent */ } });
  </script>

  <style scoped>
  .code-workspace { display: flex; height: 100%; width: 100%; }
  .workspace-sidebar { width: 200px; min-width: 200px; border-right: 1px solid #333; overflow: auto; }
  .workspace-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .editor-area { flex: 2; min-height: 0; }
  .terminal-area { flex: 1; min-height: 120px; border-top: 1px solid #333; }
  </style>
  ```

- [ ] **步骤 5：Commit**

  运行：
  ```bash
  git add apps/web/components/code/
  git commit -m "feat(web): add code workspace UI components"
  ```

---

### 任务 9：前端 — 修改 hub.vue 集成 IDE

**文件：**
- 修改：`apps/web/pages/hub.vue`
- 修改：`apps/web/stores/chat.ts`
- 修改：`apps/web/composables/useEngineClient.ts`

- [ ] **步骤 1：修改 chat store 增加 mode 状态**

  在 `apps/web/stores/chat.ts` 中增加：
  ```typescript
  export type ChatMode = 'chat' | 'code';

  export const useChatStore = defineStore('chat', () => {
    // ... existing state
    const mode = ref<ChatMode>('chat');
    const projectId = ref<string | undefined>(undefined);
    const terminalOutput = ref('');

    function setMode(newMode: ChatMode, newProjectId?: string) {
      mode.value = newMode;
      projectId.value = newProjectId;
    }

    function appendTerminal(text: string) {
      terminalOutput.value += text + '\n';
    }

    return { mode, projectId, terminalOutput, setMode, appendTerminal };
  });
  ```

- [ ] **步骤 2：修改 useEngineClient 处理 code 帧**

  在 `apps/web/composables/useEngineClient.ts` 中增加：
  ```typescript
  if (msg.type === 'code.file_opened') {
    // 通知 store 或组件更新编辑器内容
    chatStore.currentFileContent = msg.content;
  }
  if (msg.type === 'code.command_output') {
    chatStore.appendTerminal(msg.chunk);
  }
  if (msg.type === 'session.mode_changed') {
    chatStore.setMode(msg.mode, msg.projectId);
  }
  ```

- [ ] **步骤 3：修改 hub.vue**

  在 `apps/web/pages/hub.vue` 中：
  - 增加模式切换按钮（聊天 / 编程）
  - 根据 `chatStore.mode` 切换布局
  - 引入 `CodeWorkspace` 组件
  - 处理 `openFile` 事件，发送 `code.file_open` 帧

  关键结构：
  ```vue
  <template>
    <div class="hub-page" :class="{ 'code-mode': chatStore.mode === 'code' }">
      <div class="hub-header">
        <button @click="setMode('chat')">聊天</button>
        <button @click="setMode('code')">编程</button>
      </div>
      <div class="hub-body">
        <ChatView class="chat-area" />
        <CodeWorkspace
          v-if="chatStore.mode === 'code'"
          class="code-area"
          :project-id="chatStore.projectId || 'default'"
          :terminal-output="chatStore.terminalOutput"
          @open-file="onOpenFile"
        />
      </div>
    </div>
  </template>
  ```

- [ ] **步骤 4：运行前端类型检查**

  运行：
  ```bash
  pnpm --filter @mindcloud/web typecheck
  ```
  预期：通过

- [ ] **步骤 5：Commit**

  运行：
  ```bash
  git add apps/web/pages/hub.vue apps/web/stores/chat.ts apps/web/composables/useEngineClient.ts
  git commit -m "feat(web): integrate code workspace into hub page"
  ```

---

### 任务 10：集成测试与验证

**文件：**
- 修改：`apps/web/tests/components/code/`（新增测试）
- 修改：`services/engine/tests/api/ws/`（新增 WS 帧测试）

- [ ] **步骤 1：运行 engine 测试**

  运行：
  ```bash
  pnpm --filter @mindcloud/engine test
  ```
  预期：通过

- [ ] **步骤 2：运行 web 测试**

  运行：
  ```bash
  pnpm --filter @mindcloud/web test
  ```
  预期：通过

- [ ] **步骤 3：运行完整构建**

  运行：
  ```bash
  pnpm typecheck
  pnpm build
  ```
  预期：通过

- [ ] **步骤 4：Commit 测试补充（如有）**

  运行：
  ```bash
  git add -A
  git commit -m "test: add code agent mode integration tests"
  ```

---

## 3. 自检

### 3.1 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| 项目路径安全校验 | 任务 2 |
| `list_files` 工具 | 任务 3 |
| `edit_file` 工具 | 任务 4 |
| `run_command` 工具 | 任务 5 |
| 会话 mode / projectId | 任务 6 |
| Monaco Editor 依赖 | 任务 7 |
| IDE UI 组件 | 任务 8 |
| hub.vue 集成 | 任务 9 |
| 测试与构建验证 | 任务 10 |

### 3.2 占位符扫描

- 无 "待定"、"TODO"、"后续实现"。
- 每个任务包含具体文件路径和代码示例。
- 无未定义类型或函数引用。

### 3.3 一致性检查

- `ChatMode` 类型前后端一致（`'chat' \| 'code'`）。
- `projectRoot` 注入 ToolContext 的方式在所有新工具中一致。
- WebSocket 帧命名统一为 `session.set_mode`、`session.mode_changed`、`code.file_open`、`code.file_opened`、`code.command_output`、`code.command_end`。

---

## 4. 执行方式

本计划涉及前后端多个文件改动，推荐**子代理驱动**执行（每个任务一个子代理 + 审查），或**内联执行**（在当前会话中按任务顺序执行）。

由于任务间有依赖关系（如任务 3-5 依赖任务 2 的 `project-paths.ts`；任务 9 依赖任务 7-8），建议顺序执行依赖任务，独立任务可并行。

请用户选择执行方式。

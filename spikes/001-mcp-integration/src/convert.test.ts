/** schema 转换的可运行断言：pnpm tsx src/convert.test.ts */
import assert from "node:assert/strict";
import { z } from "zod";
import { mcpToolToEngineSpec, mapAnnotationsToApproval, jsonSchemaToZod } from "./convert.js";

// 1. 只读工具（模拟 read_file 经 MCP 暴露的形态）
const readSpec = mcpToolToEngineSpec({
  name: "read_file",
  description: "读取文件",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "文件路径" } },
    required: ["path"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});
assert.equal(readSpec.requiresApproval, false, "readOnlyHint=true 应免审批");
assert.equal(readSpec.noRemember, false);

// 2. schema 转换后的 zod 行为
const params = readSpec.parameters as z.ZodTypeAny;
assert.deepEqual(params.parse({ path: "a.txt" }), { path: "a.txt" });
assert.throws(() => params.parse({}), "缺 required 字段应抛错");

// 3. 破坏性工具
const delSpec = mcpToolToEngineSpec({
  name: "delete_file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  annotations: { readOnlyHint: false, destructiveHint: true },
});
assert.equal(delSpec.requiresApproval, true, "destructiveHint=true 应需审批");
assert.equal(delSpec.noRemember, true, "破坏性工具应禁止 remember");

// 4. 无 annotations（fail-closed）
assert.deepEqual(mapAnnotationsToApproval(undefined), { requiresApproval: true, noRemember: true });

// 5. 标量/枚举/数组
const complex = jsonSchemaToZod({
  type: "object",
  properties: {
    mode: { enum: ["fast", "safe"] },
    count: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    force: { type: "boolean" },
  },
  required: ["mode"],
});
assert.deepEqual(complex.parse({ mode: "fast" }), { mode: "fast" });
assert.throws(() => complex.parse({ mode: "turbo" }));
assert.deepEqual(complex.parse({ mode: "safe", count: 2, tags: ["a"] }), {
  mode: "safe",
  count: 2,
  tags: ["a"],
});

console.log("convert.test.ts: 全部断言通过 ✔");

/**
 * 恢复测试前保存的 CLOUDMIND_DATA_DIR。
 * 原值为 undefined 时必须 delete 变量——直接赋值会把进程环境变量变成
 * 字面量字符串 "undefined"，导致 getDataDir() 返回 "./undefined"，
 * 每次跑测试都在 engine 目录下生成 undefined/ 垃圾目录。
 */
export function restoreDataDir(original: string | undefined): void {
  if (original === undefined) {
    delete process.env.CLOUDMIND_DATA_DIR;
  } else {
    process.env.CLOUDMIND_DATA_DIR = original;
  }
}

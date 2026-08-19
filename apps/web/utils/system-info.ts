/**
 * 运行时长人性化格式化（秒 → 中文可读）：
 * <60s「N 秒」；<60min「N 分 M 秒」；<24h「N 小时 M 分」；否则「N 天 N 小时」。
 * 下一级单位为零时省略（如整 3 分钟 →「3 分钟」）。
 */
export function formatUptime(uptimeSec: number): string {
  const sec = Math.max(0, Math.floor(uptimeSec));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const restSec = sec % 60;
    return restSec ? `${min} 分 ${restSec} 秒` : `${min} 分钟`;
  }
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    const restMin = min % 60;
    return restMin ? `${hour} 小时 ${restMin} 分` : `${hour} 小时`;
  }
  const day = Math.floor(hour / 24);
  const restHour = hour % 24;
  return restHour ? `${day} 天 ${restHour} 小时` : `${day} 天`;
}

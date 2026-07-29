export class ProviderError extends Error {
  /** 是否可重试（错误分类，fail-closed：未分类一律 false） */
  public readonly retryable: boolean;

  constructor(
    public provider: string,
    public cause: unknown,
    options?: { retryable?: boolean }
  ) {
    super(`${provider} provider error: ${String(cause)}`);
    this.retryable = options?.retryable ?? false;
  }
}

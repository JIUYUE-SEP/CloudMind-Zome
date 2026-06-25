export class ProviderError extends Error {
  constructor(
    public provider: string,
    public cause: unknown
  ) {
    super(`${provider} provider error: ${String(cause)}`);
  }
}

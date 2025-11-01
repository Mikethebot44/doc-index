export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  shouldRetry?: (error: Error) => boolean;
}

type CoreRetryOptions = Omit<RetryOptions, 'shouldRetry'>;

const DEFAULT_OPTIONS: Required<CoreRetryOptions> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
};

export async function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions | ((error: Error) => boolean)
): Promise<T> {
  let shouldRetry: (error: Error) => boolean = () => true;
  let opts: Required<CoreRetryOptions>;

  if (typeof options === 'function') {
    shouldRetry = options;
    opts = { ...DEFAULT_OPTIONS };
  } else {
    const { shouldRetry: customShouldRetry, ...rest } = options ?? {};
    shouldRetry = customShouldRetry ?? (() => true);
    opts = { ...DEFAULT_OPTIONS, ...rest };
  }

  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const canRetry = attempt < opts.maxRetries && shouldRetry(lastError);
      if (!canRetry) {
        break;
      }

      const delay = Math.min(
        opts.initialDelay * Math.pow(opts.backoffFactor, attempt),
        opts.maxDelay
      );
      await sleep(delay);
    }
  }
  
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRateLimitError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('rate_limit') ||
    message.includes('429')
  );
}

export function isTimeoutError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('time out')
  );
}


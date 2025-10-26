import { DocIndexError } from '../types';

export function handleError(error: unknown, context?: string): never {
  if (error instanceof DocIndexError) {
    throw error;
  }
  
  if (error instanceof Error) {
    throw new DocIndexError(
      context ? `${context}: ${error.message}` : error.message,
      undefined,
      error
    );
  }
  
  throw new DocIndexError(
    context ? `${context}: Unknown error` : 'Unknown error'
  );
}

export function createError(
  message: string,
  code?: string,
  cause?: Error
): DocIndexError {
  return new DocIndexError(message, code, cause);
}


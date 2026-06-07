export function createLogger(namespace: string) {
  return {
    info: (...args: unknown[]) => console.log(`[${namespace}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${namespace}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${namespace}]`, ...args),
  };
}

export type Logger = ReturnType<typeof createLogger>;

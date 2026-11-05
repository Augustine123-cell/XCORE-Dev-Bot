/** Process-wide runtime facts. */
export const START = Date.now();

export function uptimeSeconds() {
  return Math.floor((Date.now() - START) / 1000);
}

/** Indirection so tests can intercept hard exits (restart command, shutdown). */
export const hooks = {
  exit: (code = 0) => process.exit(code),
};

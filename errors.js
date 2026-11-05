/** Small error types shared across modules (mirrors the Python ValueError / NotImplementedError). */
export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
}

export class NotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotImplementedError";
  }
}

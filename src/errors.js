export class TradingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TradingError";
    this.code = code;
  }
}

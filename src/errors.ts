/** Error raised for bad input (status 400), no route (404) or an upstream RPC failure (502). */
export class ZhookError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ZhookError";
  }
}

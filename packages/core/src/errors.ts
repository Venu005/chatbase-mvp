/** An error with an HTTP status, turned into a JSON response by handle() (./http). No Next.js import, so the voice gateway can use it. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

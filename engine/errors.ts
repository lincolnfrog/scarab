/**
 * The engine's error vocabulary and the input shapes every service validates
 * against. An ApiError carries the HTTP status the server answers with; the
 * browser's local dispatcher turns it back into a plain Error for the screen.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function bad(msg: string): never {
  throw new ApiError(400, msg)
}

export function notFound(msg: string): never {
  throw new ApiError(404, msg)
}

export const isoDay = /^\d{4}-\d{2}-\d{2}$/
export const isoMonth = /^\d{4}-\d{2}$/

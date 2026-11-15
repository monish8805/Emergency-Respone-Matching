// A readable message for errors raised by Express itself (body parsing and the like),
// instead of one generic "bad request" for everything.
export function httpErrorMessage(status: number, bodyLimit: string): string {
  switch (status) {
    case 400:
      return "malformed request body: send valid JSON";
    case 413:
      return `request body too large (limit ${bodyLimit.replace(/kb$/i, " KB").replace(/mb$/i, " MB")})`;
    case 415:
      return "unsupported content type: send application/json";
    default:
      return status >= 500 ? "internal error" : "bad request";
  }
}

// HTTP-aware error helper: thrown errors with a status are returned to the client as-is.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function httpError(status, message) {
  return new HttpError(status, message);
}

module.exports = { HttpError, httpError };

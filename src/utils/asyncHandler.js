/**
 * Envuelve un handler async y reenvía cualquier error a next().
 * @param {import('express').RequestHandler} fn
 * @returns {import('express').RequestHandler}
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

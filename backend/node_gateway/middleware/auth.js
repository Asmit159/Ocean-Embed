/**
 * JWT Authentication Middleware
 * Enforces bearer token verification across protected /api/v1/ocean/* endpoints.
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'oceanembed-super-secret-jwt-key-2024';

export function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error_code: 'UNAUTHORIZED',
      message: 'Access denied. Missing or malformed Authorization Bearer header.',
      trace_id: req.traceId,
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error_code: isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      message: isExpired ? 'JWT token has expired. Please log in again.' : 'Invalid JWT token signature.',
      trace_id: req.traceId,
    });
  }
}

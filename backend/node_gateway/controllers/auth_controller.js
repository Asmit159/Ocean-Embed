/**
 * Authentication Controller
 * Handles user authentication, credential validation (stubbed / database query),
 * and JWT token issuance.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../utils/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'oceanembed-super-secret-jwt-key-2024';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

export async function loginHandler(req, res) {
  const { email, password } = req.body || {};
  const traceId = req.traceId;

  if (!email || !password) {
    return res.status(400).json({
      error_code: 'INVALID_CREDENTIALS_PAYLOAD',
      message: 'Both email and password fields are required.',
      trace_id: traceId,
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  // HARDCODED TESTING CREDENTIALS (Bypass DB entirely for local demonstration)
  if (normalizedEmail === 'admin@oceanembed.com' && password === 'password123') {
    const tokenPayload = {
      userId: 1,
      email: normalizedEmail,
      role: 'admin',
      name: 'Admin Tester',
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(200).json({
      status: 'success',
      access_token: token,
      token_type: 'Bearer',
      expires_in: 86400,
      user: {
        id: 1,
        email: normalizedEmail,
        name: 'Admin Tester',
        role: 'admin',
      },
      trace_id: traceId,
    });
  }

  try {
    // Validate user against database
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        error_code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password provided.',
        trace_id: traceId,
      });
    }

    const user = result.rows[0];

    // Check password
    const isPasswordValid = bcrypt.compareSync(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        error_code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password provided.',
        trace_id: traceId,
      });
    }

    // Issue signed JWT
    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.full_name,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(200).json({
      status: 'success',
      access_token: token,
      token_type: 'Bearer',
      expires_in: 86400, // 24 hours in seconds
      user: {
        id: user.id,
        email: user.email,
        name: user.full_name,
        role: user.role,
      },
      trace_id: traceId,
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      error_code: 'INTERNAL_SERVER_ERROR',
      message: 'An error occurred during authentication.',
      trace_id: traceId,
    });
  }
}

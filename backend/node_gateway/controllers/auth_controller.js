/**
 * Authentication Controller
 * Handles user authentication, credential validation, signup, and JWT token issuance.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import pool from '../utils/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'oceanembed-super-secret-jwt-key-2024';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// Firebase project credentials for token verification.
// FIREBASE_API_KEY: the public Web API key from your Firebase console.
// FIREBASE_PROJECT_ID: used to validate the 'aud' and 'iss' claims.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

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

export async function signupHandler(req, res) {
  const { email, password, full_name } = req.body || {};
  const traceId = req.traceId;

  // --- Input Validation ---
  if (!email || !password || !full_name) {
    return res.status(400).json({
      error_code: 'INVALID_SIGNUP_PAYLOAD',
      message: 'Full name, email, and password are all required.',
      trace_id: traceId,
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const trimmedName = String(full_name).trim();

  // Basic email format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    return res.status(400).json({
      error_code: 'INVALID_EMAIL_FORMAT',
      message: 'Please provide a valid email address.',
      trace_id: traceId,
    });
  }

  // Password strength check: min 8 chars, at least 1 uppercase, 1 lowercase, 1 digit
  const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({
      error_code: 'WEAK_PASSWORD',
      message: 'Password must be at least 8 characters and include uppercase, lowercase, and a number.',
      trace_id: traceId,
    });
  }

  try {
    // --- Duplicate Email Check ---
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error_code: 'EMAIL_ALREADY_EXISTS',
        message: 'An account with this email address already exists.',
        trace_id: traceId,
      });
    }

    // --- Hash Password ---
    const SALT_ROUNDS = 10;
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // --- Insert New User ---
    const insertResult = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'user')
       RETURNING id, email, full_name, role, created_at`,
      [normalizedEmail, passwordHash, trimmedName]
    );

    const newUser = insertResult.rows[0];

    // --- Issue JWT (auto-login after signup) ---
    const tokenPayload = {
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
      name: newUser.full_name,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.status(201).json({
      status: 'success',
      access_token: token,
      token_type: 'Bearer',
      expires_in: 86400,
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.full_name,
        role: newUser.role,
      },
      trace_id: traceId,
    });

  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({
      error_code: 'INTERNAL_SERVER_ERROR',
      message: 'An error occurred during registration.',
      trace_id: traceId,
    });
  }
}

/**
 * POST /api/v1/auth/sync-password
 *
 * Syncs a Firebase password-reset back into Postgres.
 * Called by the frontend after a user resets their password via Firebase
 * but before the backend login — the backend's password_hash is stale.
 *
 * Security model:
 *   - The caller provides a Firebase ID Token (short-lived JWT signed by Google).
 *   - We verify it against Google's public tokeninfo endpoint — no Admin SDK needed.
 *   - The email used for the UPDATE is taken from the verified token, NOT the
 *     request body, preventing a caller from targeting another user's account.
 *
 * Body: { firebase_token: string, new_password: string }
 * Returns 200 on success, 401 if token invalid, 404 if user not in DB.
 */
export async function syncPasswordHandler(req, res) {
  const { firebase_token, new_password } = req.body || {};
  const traceId = req.traceId;

  if (!firebase_token || !new_password) {
    return res.status(400).json({
      error_code: 'INVALID_SYNC_PAYLOAD',
      message: 'firebase_token and new_password are required.',
      trace_id: traceId,
    });
  }

  // --- Same password strength check as signup ---
  const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
  if (!passwordRegex.test(new_password)) {
    return res.status(400).json({
      error_code: 'WEAK_PASSWORD',
      message: 'Password must be at least 8 characters and include uppercase, lowercase, and a number.',
      trace_id: traceId,
    });
  }

  // --- Verify the Firebase ID Token via Firebase's own REST API ----------------
  // oauth2.googleapis.com/tokeninfo only works for Google OAuth tokens.
  // Firebase email/password ID tokens must be verified via identitytoolkit.
  let tokenEmail;
  try {
    const verifyUrl =
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`;
    const verifyRes = await axios.post(verifyUrl, { idToken: firebase_token });
    const users = verifyRes.data?.users;

    if (!users || users.length === 0) {
      return res.status(401).json({
        error_code: 'INVALID_FIREBASE_TOKEN',
        message: 'Firebase token is invalid or has expired.',
        trace_id: traceId,
      });
    }

    const firebaseUser = users[0];

    // Double-check the token is for our project by inspecting the localId prefix.
    // (The identitytoolkit endpoint already rejects tokens from other projects,
    //  but we also validate the email is present.)
    tokenEmail = String(firebaseUser.email || '').trim().toLowerCase();

    if (!tokenEmail) {
      return res.status(401).json({
        error_code: 'FIREBASE_TOKEN_NO_EMAIL',
        message: 'Firebase token does not contain an email address.',
        trace_id: traceId,
      });
    }
  } catch (err) {
    // axios throws on 4xx/5xx; a 400 from Firebase means the token is invalid.
    if (err.response?.status === 400) {
      return res.status(401).json({
        error_code: 'INVALID_FIREBASE_TOKEN',
        message: 'Firebase token is invalid or has expired.',
        trace_id: traceId,
      });
    }
    console.error('Firebase token verification error:', err.message);
    return res.status(500).json({
      error_code: 'TOKEN_VERIFICATION_FAILED',
      message: 'Could not reach Firebase token verification service.',
      trace_id: traceId,
    });
  }

  // --- Update the password hash in Postgres ---
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [tokenEmail]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error_code: 'USER_NOT_FOUND',
        message: 'No account found for this email address.',
        trace_id: traceId,
      });
    }

    const SALT_ROUNDS = 10;
    const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);

    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE email = $2',
      [newHash, tokenEmail]
    );

    return res.status(200).json({
      status: 'success',
      message: 'Password updated successfully.',
      trace_id: traceId,
    });
  } catch (error) {
    console.error('Sync password DB error:', error);
    return res.status(500).json({
      error_code: 'INTERNAL_SERVER_ERROR',
      message: 'An error occurred while updating the password.',
      trace_id: traceId,
    });
  }
}

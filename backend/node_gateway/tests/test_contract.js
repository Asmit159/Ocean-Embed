/**
 * Automated Verification Script: Ocean API Contract & Validation
 */

import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { validateCoordinates, isMultipleOfFive } from '../utils/coordinate_validator.js';

console.log('--- 1. Testing 5-Degree Grid Coordinate Validator ---');

// Valid cases
const valid1 = validateCoordinates('10', '80');
assert.strictEqual(valid1.isValid, true, '10, 80 should be valid');
assert.strictEqual(valid1.lat, 10);
assert.strictEqual(valid1.lon, 80);

const valid2 = validateCoordinates('-15.0', '65.0');
assert.strictEqual(valid2.isValid, true, '-15, 65 should be valid');

const valid3 = validateCoordinates('0', '0');
assert.strictEqual(valid3.isValid, true, '0, 0 should be valid');

// Invalid multiples of 5
const invalid1 = validateCoordinates('12', '80');
assert.strictEqual(invalid1.isValid, false, 'lat=12 should be invalid');
assert.strictEqual(invalid1.status, 422);
assert.strictEqual(invalid1.errorCode, 'INVALID_COORDINATES');

const invalid2 = validateCoordinates('10', '83.5');
assert.strictEqual(invalid2.isValid, false, 'lon=83.5 should be invalid');
assert.strictEqual(invalid2.status, 422);
assert.strictEqual(invalid2.errorCode, 'INVALID_COORDINATES');

// Out of bounds
const invalid3 = validateCoordinates('95', '0');
assert.strictEqual(invalid3.isValid, false, 'lat=95 should be out of range');
assert.strictEqual(invalid3.errorCode, 'INVALID_COORDINATES');

const invalid4 = validateCoordinates('0', '-185');
assert.strictEqual(invalid4.isValid, false, 'lon=-185 should be out of range');

console.log('✓ Coordinate validation tests passed.');

console.log('--- 2. Testing JWT Generation & Verification ---');
const secret = 'oceanembed-super-secret-jwt-key-2024';
const token = jwt.sign({ userId: 'usr_1', email: 'admin@oceanembed.ai' }, secret, { expiresIn: '24h' });
assert.ok(token, 'JWT token generated');

const decoded = jwt.verify(token, secret);
assert.strictEqual(decoded.email, 'admin@oceanembed.ai');
console.log('✓ JWT authentication tokens verified.');

console.log('\nAll API Contract Unit Tests PASSED!');

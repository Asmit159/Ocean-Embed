/**
 * Integration Test for Express Server Routes, Auth Middleware, and Coordinate Validation
 */

import http from 'node:http';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';

const BASE_URL = 'http://localhost:3001';
process.env.PORT = '3001';
process.env.NODE_ENV = 'test';

// Dynamically import server
await import('../server.js');

// Helper to make HTTP requests
function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = { ...headers };
    let reqBody = null;

    if (body) {
      reqBody = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(reqBody);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (_) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// Give server a moment to bind
await new Promise((r) => setTimeout(r, 600));

console.log('--- 1. Testing POST /api/v1/auth/login ---');
// Bad password
const badLogin = await makeRequest('POST', '/api/v1/auth/login', {
  email: 'admin@oceanembed.ai',
  password: 'WrongPassword123'
});
assert.strictEqual(badLogin.status, 401, 'Should fail with 401');
assert.strictEqual(badLogin.data.error_code, 'INVALID_CREDENTIALS');
console.log('✓ Invalid password correctly rejected with 401.');

// Valid login
const goodLogin = await makeRequest('POST', '/api/v1/auth/login', {
  email: 'admin@oceanembed.ai',
  password: 'OceanEmbed2024!'
});
assert.strictEqual(goodLogin.status, 200, 'Should succeed with 200');
assert.ok(goodLogin.data.access_token, 'Should return JWT access_token');
assert.strictEqual(goodLogin.data.token_type, 'Bearer');
console.log('✓ Successful login returned valid JWT access_token.');

const token = goodLogin.data.access_token;

console.log('--- 2. Testing JWT Auth Protection ---');
// Unauthenticated request to /profile
const unauth = await makeRequest('GET', '/api/v1/ocean/profile?lat=10&lon=80&date=2024-06-15');
assert.strictEqual(unauth.status, 401, 'Unauthenticated request should return 401');
assert.strictEqual(unauth.data.error_code, 'UNAUTHORIZED');
console.log('✓ Protected route rejects unauthenticated request with 401.');

console.log('--- 3. Testing 5-Degree Grid Validation (422 INVALID_COORDINATES) ---');
// Invalid coordinates (lat=12 not a multiple of 5)
const invalidCoord = await makeRequest(
  'GET',
  '/api/v1/ocean/profile?lat=12&lon=80&date=2024-06-15',
  null,
  { Authorization: `Bearer ${token}` }
);
assert.strictEqual(invalidCoord.status, 422, 'Should reject lat=12 with 422');
assert.strictEqual(invalidCoord.data.error_code, 'INVALID_COORDINATES');
console.log('✓ Non-multiple of 5 coordinates correctly rejected with 422 INVALID_COORDINATES.');

console.log('--- 4. Testing GET /api/v1/health ---');
const health = await makeRequest('GET', '/api/v1/health');
assert.strictEqual(health.status, 200, 'Health check should return 200');
assert.strictEqual(health.data.status, 'ok');
assert.strictEqual(health.data.version, '1.0.0');
console.log('✓ Health endpoint verified.');

console.log('\nAll Express Route & Auth Integration Tests PASSED!');
process.exit(0);

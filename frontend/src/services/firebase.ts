// ─── Firebase Initialisation & Google OAuth ───────────────────────────────────
// Uses the modular Firebase v9+ SDK for minimum bundle size.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  type User,
} from 'firebase/auth';
import { getAnalytics } from 'firebase/analytics';

// ─── Firebase Config ──────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: 'AIzaSyBe-S4ShiDO9Cxwrwfx_eJzau_6yDzUV9U',
  authDomain: 'oceanembed-1b65a.firebaseapp.com',
  projectId: 'oceanembed-1b65a',
  storageBucket: 'oceanembed-1b65a.firebasestorage.app',
  messagingSenderId: '7036925970',
  appId: '1:7036925970:web:de51992ec129aabba340cb',
  measurementId: 'G-4HBJX9E3FY',
};

// ─── App, Auth & Analytics ────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const analytics = getAnalytics(app);

// ─── Google Provider ──────────────────────────────────────────────────────────
const googleProvider = new GoogleAuthProvider();
// Request email & profile scopes (default) and force account selection every time
googleProvider.setCustomParameters({ prompt: 'select_account' });

// ─── Auth Helpers ─────────────────────────────────────────────────────────────

/**
 * Opens the Google sign-in popup.
 * Returns the signed-in Firebase User on success.
 * Throws on cancellation or error.
 */
export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

/**
 * Signs the current user out of Firebase.
 */
export async function signOutUser(): Promise<void> {
  await firebaseSignOut(auth);
}

// ─── Auth Change Suppression ──────────────────────────────────────────────────
// During an email/password login flow, we temporarily sign into Firebase to
// check emailVerified. This triggers onAuthStateChanged, which would otherwise
// call setIsAuthenticated(true) in App.tsx — unmounting the LoginPage mid-flow.
// Setting this flag to true silences those spurious notifications.
let _suppressAuthChanges = false;

/**
 * Call with true at the start of a login flow and false in the finally block.
 * While suppressed, onAuthChange callbacks are silently dropped.
 */
export function setAuthChangeSuppressed(suppressed: boolean): void {
  _suppressAuthChanges = suppressed;
}

/**
 * Subscribes to Firebase auth state changes.
 * Returns the unsubscribe function.
 * Callbacks are suppressed while setAuthChangeSuppressed(true) is active.
 */
export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (_suppressAuthChanges) return; // ignore mid-login-flow state changes
    callback(user);
  });
}

/**
 * Creates a Firebase email/password user.
 * Called during signup so Firebase can manage the account and send verification emails.
 */
export async function createFirebaseUser(email: string, password: string): Promise<User> {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

/**
 * Sends a verification email to the currently signed-in Firebase user.
 */
export async function sendVerificationEmail(): Promise<void> {
  if (auth.currentUser) {
    await sendEmailVerification(auth.currentUser);
  }
}

/**
 * Signs in with email/password via Firebase.
 * Used during login to check emailVerified status before allowing access.
 * The caller should sign out immediately after checking if they only need
 * the verification status and are using a separate backend JWT.
 */
export async function signInFirebaseEmail(email: string, password: string): Promise<User> {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

/**
 * Sends a Firebase password-reset email to the given address.
 * Firebase handles the secure token generation and branded email delivery.
 * Throws if the email is not registered (auth/user-not-found).
 */
export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

/**
 * Returns a short-lived Firebase ID Token for the currently signed-in user.
 * Used to prove Firebase identity to the backend (e.g. for sync-password).
 * forceRefresh=true guarantees a fresh token even if a cached one exists.
 */
export async function getFirebaseIdToken(forceRefresh = false): Promise<string> {
  if (!auth.currentUser) throw new Error('No Firebase user is currently signed in.');
  return auth.currentUser.getIdToken(forceRefresh);
}

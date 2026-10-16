import React, { useState } from 'react';
import { User, Lock, Eye, EyeOff, MailCheck, KeyRound, ArrowLeft } from 'lucide-react';
import bgImage from '../assets/images/Signin_Background.webp';
import Logo from '../assets/logo.svg';
import { API_BASE_URL, setInMemoryToken } from '../services/api';
import { signInWithGoogle, signInFirebaseEmail, sendVerificationEmail, signOutUser, sendPasswordReset, getFirebaseIdToken, setAuthChangeSuppressed } from '../services/firebase';
import './LoginPage.css';

interface LoginPageProps {
  onLogin: () => void;
  onNavigateToSignup: () => void;
}

const LoginPage: React.FC<LoginPageProps> = ({ onLogin, onNavigateToSignup }) => {
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  // ── Forgot Password state ──────────────────────────────────────────────────
  const [forgotMode, setForgotMode] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setUnverifiedEmail(false);
    setIsLoading(true);

    // ── Suppress Firebase auth state listener for the entire login flow ────────
    // signInFirebaseEmail (used to check emailVerified) triggers onAuthStateChanged.
    // Without suppression, App.tsx sees a verified user and calls setIsAuthenticated(true),
    // unmounting this page mid-flow. We restore the listener in the finally block.
    setAuthChangeSuppressed(true);

    // Clear any stale localStorage token to prevent a different race condition
    // (onAuthStateChanged(null) finding an old 'remember me' token).
    localStorage.removeItem('token');

    // Tracks whether Firebase accepted the credentials so we can give a better
    // error if the backend rejects them (post-reset password sync gap).
    let firebaseVerified = false;
    let firebaseIdToken: string | null = null;

    try {
      // ── Step 1: Check Firebase email verification ──────────────────────────
      // Sign into Firebase only to read emailVerified, then sign out immediately.
      // If Firebase doesn't know this user (legacy account), skip silently.
      try {
        const firebaseUser = await signInFirebaseEmail(email, password);
        if (!firebaseUser.emailVerified) {
          await signOutUser();
          setUnverifiedEmail(true);
          setError('Please verify your email address before logging in.');
          setIsLoading(false);
          return;
        }
        firebaseVerified = true; // Firebase accepted this password ✓

        // Grab the ID token NOW while the user is still signed in.
        // We need it for /auth/sync-password if the backend login fails.
        firebaseIdToken = await getFirebaseIdToken();

        await signOutUser();     // signed in only for the check
      } catch (firebaseErr: any) {
        // auth/wrong-password / auth/invalid-credential → likely a legacy account
        // that predates Firebase or the password hasn't changed → skip silently.
        const ignoredCodes = ['auth/user-not-found', 'auth/invalid-credential', 'auth/wrong-password'];
        if (!ignoredCodes.includes(firebaseErr?.code)) {
          throw firebaseErr;
        }
      }

      // ── Step 2: Complete backend registration on first post-verification login ─
      const rawPending = sessionStorage.getItem('pendingSignup');
      if (rawPending) {
        try {
          const pending = JSON.parse(rawPending);
          if (pending.email === email) {
            const signupRes = await fetch(`${API_BASE_URL}/auth/signup`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ full_name: pending.fullName, email: pending.email, password: pending.password }),
            });
            if (signupRes.ok || signupRes.status === 409 || signupRes.status === 400) {
              sessionStorage.removeItem('pendingSignup');
            }
          }
        } catch {
          // Registration completion failed — proceed to login anyway.
        }
      }

      // ── Step 3: Backend login ──────────────────────────────────────────────
      let response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      // ── Step 4: Auto-sync password if backend hash is stale ───────────────
      // Firebase accepted the password (firebaseVerified=true) but the backend
      // returned 401/403 — the password_hash in Postgres is from before the
      // Firebase reset. Automatically sync it and retry login.
      if (!response.ok && firebaseVerified && firebaseIdToken &&
          (response.status === 401 || response.status === 403)) {
        try {
          const syncRes = await fetch(`${API_BASE_URL}/auth/sync-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firebase_token: firebaseIdToken, new_password: password }),
          });

          if (syncRes.ok) {
            // Hash is updated — retry the backend login with the new password
            response = await fetch(`${API_BASE_URL}/auth/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password }),
            });
          }
          // If sync itself failed, fall through and show the original login error
        } catch {
          // Network error on sync — fall through to show the original error
        }
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Login failed');
      }

      // Store token based on rememberMe preference
      if (rememberMe) {
        localStorage.setItem('token', data.access_token);
        sessionStorage.removeItem('token');
      } else {
        setInMemoryToken(data.access_token);
        localStorage.removeItem('token');
        sessionStorage.removeItem('token');
      }

      onLogin();
    } catch (err: any) {
      setError(err.message);
    } finally {
      // Always restore the auth listener — whether login succeeded or failed.
      setAuthChangeSuppressed(false);
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    setResendLoading(true);
    setResendSuccess(false);
    try {
      await signInFirebaseEmail(email, password);
      await sendVerificationEmail();
      await signOutUser();
      setResendSuccess(true);
      setError('');
    } catch {
      setError('Could not resend the email. Please try again.');
    } finally {
      setResendLoading(false);
    }
  };

  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');
    setResetLoading(true);
    try {
      await sendPasswordReset(resetEmail);
      setResetSent(true);
    } catch (err: any) {
      if (err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential') {
        // Don't reveal whether the email is registered — prevents enumeration attacks
        setResetSent(true);
      } else {
        setResetError(err?.message || 'Could not send reset email. Please try again.');
      }
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="login-container" style={{ backgroundImage: `url(${bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
      
      {/* Left-Side Branding */}
      <div className="branding-container">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <img src={Logo} alt="OceanEmbed Logo" style={{ width: '64px', height: '64px' }} />
          <h1 className="branding-title">OceanEmbed</h1>
        </div>
      </div>

      {/* Right-Side Glassmorphic Card */}
      <div 
        className="glass-card-container"
        style={{
          background: 'rgba(4, 21, 45, 0.4)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderRadius: '1.5rem',
          border: '1px solid rgba(139, 182, 214, 0.2)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          padding: '2rem',
          width: '100%',
          maxWidth: '28rem',
          boxSizing: 'border-box'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '1.5rem', textAlign: 'center' }}>
          {forgotMode ? (
            <>
              <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(37, 99, 235, 0.15)', border: '1px solid rgba(37, 99, 235, 0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '0.75rem' }}>
                <KeyRound size={26} color="#60A5FA" />
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#FFFFFF', margin: 0 }}>Reset Password</h2>
              <p style={{ fontSize: '0.85rem', color: '#94A3B8', margin: '0.4rem 0 0' }}>Enter your email and we'll send a reset link.</p>
            </>
          ) : (
            <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#FFFFFF', margin: 0, paddingBottom: '0.25rem' }}>Welcome Back</h2>
          )}
        </div>



        {error && (
          <div style={{ borderRadius: '0.5rem', marginBottom: '1rem', textAlign: 'center', fontSize: '0.875rem', overflow: 'hidden' }}>
            <div style={{ color: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '0.75rem' }}>
              {error}
            </div>
            {unverifiedEmail && (
              <div style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)', padding: '0.6rem 0.75rem', borderTop: '1px solid rgba(239,68,68,0.2)' }}>
                {resendSuccess ? (
                  <p style={{ margin: 0, color: '#34d399', fontSize: '0.8rem' }}>
                    ✓ Verification email sent! Check your inbox.
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resendLoading}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#93C5FD', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', opacity: resendLoading ? 0.6 : 1 }}
                  >
                    <MailCheck size={14} />
                    {resendLoading ? 'Sending...' : 'Resend verification email'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Forgot Password view ── */}
        {forgotMode ? (
          resetSent ? (
            /* Success screen */
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', textAlign: 'center', padding: '0.5rem 0' }}>
              <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(52, 211, 153, 0.12)', border: '1px solid rgba(52, 211, 153, 0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <MailCheck size={30} color="#34d399" />
              </div>
              <p style={{ color: '#CBD5E1', fontSize: '0.9rem', margin: 0, lineHeight: 1.6 }}>
                If <span style={{ color: '#fff', fontWeight: 600 }}>{resetEmail}</span> is registered, a reset link is on its way.
              </p>
              <p style={{ color: '#64748B', fontSize: '0.8rem', margin: 0 }}>Check your spam folder if you don't see it.</p>
              <button
                type="button"
                onClick={() => { setForgotMode(false); setResetSent(false); setResetEmail(''); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#93C5FD', fontSize: '0.875rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.25rem' }}
              >
                <ArrowLeft size={15} /> Back to Login
              </button>
            </div>
          ) : (
            /* Reset email form */
            <form onSubmit={handlePasswordReset}>
              {resetError && (
                <div style={{ color: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>
                  {resetError}
                </div>
              )}
              <div className="input-container">
                <User className="input-icon" size={20} />
                <input
                  type="email"
                  className="input-field"
                  placeholder="Your email address"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="primary-btn"
                disabled={resetLoading}
                style={{ marginTop: '1.25rem', opacity: resetLoading ? 0.7 : 1 }}
              >
                {resetLoading
                  ? <span style={{ display: 'inline-block', width: 18, height: 18, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  : null
                }
                {resetLoading ? 'Sending...' : 'Send Reset Link'}
              </button>
              <button
                type="button"
                onClick={() => { setForgotMode(false); setResetError(''); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.35rem', margin: '1rem auto 0', padding: 0 }}
              >
                <ArrowLeft size={15} /> Back to Login
              </button>
            </form>
          )
        ) : (
          /* ── Normal login form ── */
          <>
          <form onSubmit={handleLogin}>

          <div className="input-container">
            <User className="input-icon" size={20} />
            <input 
              type="email" 
              className="input-field" 
              placeholder="Email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              onInvalid={(e) => (e.target as HTMLInputElement).setCustomValidity('Please enter a valid email address.')}
              onInput={(e) => (e.target as HTMLInputElement).setCustomValidity('')}
            />
          </div>

          <div className="input-container">
            <Lock className="input-icon" size={20} />
            <input 
              type={showPassword ? "text" : "password"} 
              className="input-field" 
              placeholder="Password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button 
              type="button" 
              className="password-toggle" 
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '1rem 0', fontSize: '0.875rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#D1D5DB', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer' }}
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              Remember me
            </label>
            <a
              href="#"
              className="text-link"
              onClick={(e) => { e.preventDefault(); setForgotMode(true); setResetError(''); setResetSent(false); setResetEmail(email); }}
            >
              Forgot Password?
            </a>
          </div>

          <button type="submit" className="primary-btn" disabled={isLoading} style={{ opacity: isLoading ? 0.7 : 1 }}>
            {isLoading ? 'Logging in...' : 'Login'}
          </button>
          </form>

          <div className="divider">
            <div className="divider-line"></div>
            <span className="divider-text">OR</span>
            <div className="divider-line"></div>
          </div>

          <button
            type="button"
            className="secondary-btn"
            disabled={isGoogleLoading}
            style={{ opacity: isGoogleLoading ? 0.7 : 1 }}
            onClick={async () => {
              setError('');
              setIsGoogleLoading(true);
              try {
                await signInWithGoogle();
                onLogin();
              } catch (err: any) {
                if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
                  setError(err?.message || 'Google sign-in failed. Please try again.');
                }
              } finally {
                setIsGoogleLoading(false);
              }
            }}
          >
            {isGoogleLoading ? (
              <span style={{ display: 'inline-block', width: 20, height: 20, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            {isGoogleLoading ? 'Signing in...' : 'Continue with Google'}
          </button>

          <p style={{ textAlign: 'center', marginTop: '1.5rem', marginBottom: 0, fontSize: '0.875rem', color: '#D1D5DB' }}>
            Don't have an account? <a href="#" onClick={(e) => { e.preventDefault(); onNavigateToSignup(); }} className="text-link" style={{ color: '#FFFFFF', fontWeight: 500 }}>Sign Up</a>
          </p>
          </>
        )}
      </div>
    </div>
  );
};

export default LoginPage;

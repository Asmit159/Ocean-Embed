import { useState, useEffect } from 'react';
import OceanGlobeView from './components/OceanGlobeView';
import LoginPage from './components/LoginPage';
import SignupPage from './components/SignupPage';
import { checkBackendHealth } from './services/api';
import { onAuthChange } from './services/firebase';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authView, setAuthView] = useState<'login' | 'signup'>('login');

  useEffect(() => {
    // Ping backend to wake it up from sleep (e.g. Render free tier)
    checkBackendHealth().then((isAwake) => {
      if (isAwake) console.log('Backend is awake!');
    });

    // Subscribe to Firebase auth state — covers both Google OAuth and
    // email/password sessions. Returns an unsubscribe function for cleanup.
    const unsubscribe = onAuthChange((user) => {
      if (user && (user.emailVerified || user.providerData.some(p => p.providerId === 'google.com'))) {
        // Fully verified Firebase session (Google OAuth or verified email)
        setIsAuthenticated(true);
      } else if (!user) {
        // No Firebase session — fall back to legacy JWT in localStorage
        setIsAuthenticated(!!localStorage.getItem('token'));
      }
      // Unverified email users → don't touch auth state; they stay on the signup page
    });

    return () => unsubscribe();
  }, []);

  if (!isAuthenticated) {
    if (authView === 'login') {
      return (
        <LoginPage 
          onLogin={() => setIsAuthenticated(true)} 
          onNavigateToSignup={() => setAuthView('signup')}
        />
      );
    } else {
      return (
        <SignupPage 
          onSignup={() => setIsAuthenticated(true)}
          onNavigateToLogin={() => setAuthView('login')}
        />
      );
    }
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <OceanGlobeView />
    </div>
  );
}

export default App;

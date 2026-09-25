import React, { useState } from 'react';
import { User, Lock, Mail, Eye, EyeOff } from 'lucide-react';
import bgImage from '../assets/images/Signin_Background.webp';
import Logo from '../assets/logo.svg';
import './LoginPage.css'; // Reusing the exact same glassmorphism styles

interface SignupPageProps {
  onSignup: () => void;
  onNavigateToLogin: () => void;
}

const SignupPage: React.FC<SignupPageProps> = ({ onSignup, onNavigateToLogin }) => {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) return;
    onSignup();
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
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#FFFFFF', margin: 0, paddingBottom: '0.25rem' }}>Create an Account</h2>
          <p style={{ color: '#D1D5DB', margin: 0, fontSize: '0.875rem' }}>Register to access INCOIS telemetry</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="input-container">
            <User className="input-icon" size={20} />
            <input 
              type="text" 
              className="input-field" 
              placeholder="Full Name" 
              required
            />
          </div>

          <div className="input-container">
            <Mail className="input-icon" size={20} />
            <input 
              type="email" 
              className="input-field" 
              placeholder="Email Address" 
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
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (e.target.value !== confirmPassword && confirmPassword) {
                  e.target.setCustomValidity("Passwords do not match");
                } else {
                  e.target.setCustomValidity("");
                }
              }}
              minLength={8}
              pattern="(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}"
              title="Must contain at least 8 characters, including uppercase, lowercase, and numbers"
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

          <div className="input-container">
            <Lock className="input-icon" size={20} />
            <input 
              type={showConfirmPassword ? "text" : "password"} 
              className="input-field" 
              placeholder="Confirm Password" 
              required
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (e.target.value !== password) {
                  e.target.setCustomValidity("Passwords do not match");
                } else {
                  e.target.setCustomValidity("");
                }
              }}
              minLength={8}
            />
            <button 
              type="button" 
              className="password-toggle" 
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
            >
              {showConfirmPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>

          <button type="submit" className="primary-btn" style={{ marginTop: '1.5rem' }}>
            Sign Up
          </button>
        </form>

        <div className="divider">
          <div className="divider-line"></div>
          <span className="divider-text">OR</span>
          <div className="divider-line"></div>
        </div>

        <button type="button" className="secondary-btn">
          <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>

        <p style={{ textAlign: 'center', marginTop: '1.5rem', marginBottom: 0, fontSize: '0.875rem', color: '#D1D5DB' }}>
          Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); onNavigateToLogin(); }} className="text-link" style={{ color: '#FFFFFF', fontWeight: 500 }}>Login</a>
        </p>
      </div>
    </div>
  );
};

export default SignupPage;

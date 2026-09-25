import React, { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';

interface CoordinateSearchProps {
  onSearch: (coords: { lat: number; lon: number }) => void;
}

const BOUNDS = {
  bob: { minLat: 5, maxLat: 22, minLon: 80, maxLon: 100 },
  as:  { minLat: 8, maxLat: 25, minLon: 50, maxLon: 77 },
};

const CoordinateSearch: React.FC<CoordinateSearchProps> = ({ onSearch }) => {
  const [latStr, setLatStr] = useState('');
  const [lonStr, setLonStr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorHiding, setErrorHiding] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showError = useCallback((msg: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setErrorHiding(false);
    setError(msg);
    errorTimerRef.current = setTimeout(() => {
      setErrorHiding(true);
      setTimeout(() => {
        setError(null);
        setErrorHiding(false);
      }, 300);
    }, 4000);
  }, []);

  const handleSearch = useCallback(() => {
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);

    if (isNaN(lat) || isNaN(lon)) {
      showError('Error: Please enter valid numeric coordinates.');
      return;
    }

    const inBoB =
      lat >= BOUNDS.bob.minLat && lat <= BOUNDS.bob.maxLat &&
      lon >= BOUNDS.bob.minLon && lon <= BOUNDS.bob.maxLon;

    const inAS =
      lat >= BOUNDS.as.minLat && lat <= BOUNDS.as.maxLat &&
      lon >= BOUNDS.as.minLon && lon <= BOUNDS.as.maxLon;

    if (!inBoB && !inAS) {
      showError('Error: Coordinates must be within the Arabian Sea or Bay of Bengal.');
      return;
    }

    // Clear any existing error
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setError(null);
    setErrorHiding(false);

    onSearch({ lat, lon });
  }, [latStr, lonStr, onSearch, showError]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  }, [handleSearch]);

  return (
    <motion.div 
      className="coordinate-search"
      initial={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
    >
      <div className="coord-field">
        <input
          className="coord-input"
          type="number"
          step="any"
          placeholder="Lat"
          value={latStr}
          onChange={(e) => setLatStr(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="coord-unit">°N</span>
      </div>

      <div className="coord-divider" />

      <div className="coord-field">
        <input
          className="coord-input"
          type="number"
          step="any"
          placeholder="Lon"
          value={lonStr}
          onChange={(e) => setLonStr(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="coord-unit">°E</span>
      </div>

      <button className="search-btn" onClick={handleSearch} title="Search coordinates">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>

      {/* Error toast */}
      {error && (
        <div className={`search-error-toast ${errorHiding ? 'hiding' : ''}`}>
          {error}
        </div>
      )}
    </motion.div>
  );
};

export default CoordinateSearch;

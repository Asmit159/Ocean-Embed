import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { type OceanDataResponse, fetchHistoricalData } from '../services/api';

interface ObservationModalProps {
  isOpen: boolean;
  onClose: () => void;
  metricType: 'SST' | 'SSS' | 'SSH' | 'Currents' | 'Winds' | null;
  data: OceanDataResponse | null;
  selectedDate: Date;
  latRange?: [number, number];
  lngRange?: [number, number];
}

const ObservationModal: React.FC<ObservationModalProps> = ({ isOpen, onClose, metricType, data, selectedDate, latRange, lngRange }) => {
  const [shouldRender, setShouldRender] = useState(false);
  const [activeTab, setActiveTab] = useState<'magnitude' | 'direction'>('magnitude');
  const prevData = useRef(data);
  const prevMetricType = useRef(metricType);

  if (data) prevData.current = data;
  if (metricType) prevMetricType.current = metricType;

  const currentData = data || prevData.current;
  const currentMetricType = metricType || prevMetricType.current;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    if (!isOpen || !currentData || !currentMetricType) return;
    
    const effectiveTab = (currentMetricType === 'Currents' || currentMetricType === 'Winds') ? activeTab : 'magnitude';
    if (effectiveTab !== 'direction') return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get the grid data
    const gridData = currentMetricType === 'Currents' 
      ? currentData.surface_inputs.currents_vector_grid 
      : currentData.surface_inputs.winds_vector_grid;
    
    if (!gridData) return;

    // We invert the rows so North is up, just like the previous grid
    const dataMatrix = [...gridData].reverse();
    const rows = dataMatrix.length;
    const cols = dataMatrix[0].length;
    
    // Set internal resolution of the canvas
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width || 350;
    canvas.height = rect.height || 350;

    const width = canvas.width;
    const height = canvas.height;

    const cellW = width / cols;
    const cellH = height / rows;

    type Particle = { x: number; y: number; prevX: number; prevY: number; age: number; lifespan: number };
    const numParticles = 200;
    const particles: Particle[] = Array.from({ length: numParticles }, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      return {
        x, y,
        prevX: x, prevY: y,
        age: 0,
        lifespan: Math.floor(Math.random() * 100) + 50
      };
    });

    let animationFrameId: number;
    
    const speedMultiplier = currentMetricType === 'Winds' ? 0.2 : 3.0;
    const particleColor = currentMetricType === 'Currents' ? '#fde725' : '#d4a5a5';

    // Fill initial background solidly once
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    const render = () => {
      // Fading trails effect
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.15)'; // trail fade speed
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = particleColor;
      ctx.globalAlpha = 0.8;
      ctx.lineCap = 'round';

      particles.forEach(p => {
        const exactJ = p.x / cellW - 0.5;
        const exactI = p.y / cellH - 0.5;
        
        const j1 = Math.max(0, Math.floor(exactJ));
        const j2 = Math.min(cols - 1, j1 + 1);
        const i1 = Math.max(0, Math.floor(exactI));
        const i2 = Math.min(rows - 1, i1 + 1);
        
        const fJ = exactJ - Math.floor(exactJ);
        const fI = exactI - Math.floor(exactI);

        if (p.x >= 0 && p.x < width && p.y >= 0 && p.y < height) {
          const cell11 = dataMatrix[i1][j1];
          const cell12 = dataMatrix[i1][j2];
          const cell21 = dataMatrix[i2][j1];
          const cell22 = dataMatrix[i2][j2];

          // If any surrounding cell is null (e.g. landmass), kill the particle so it respawns
          if (!cell11 || !cell12 || !cell21 || !cell22) {
            p.age = p.lifespan + 1;
          } else {
            const u11 = cell11.u, v11 = cell11.v;
            const u12 = cell12.u, v12 = cell12.v;
            const u21 = cell21.u, v21 = cell21.v;
            const u22 = cell22.u, v22 = cell22.v;
            
            const u = u11 * (1-fJ)*(1-fI) + u12 * fJ*(1-fI) + u21 * (1-fJ)*fI + u22 * fJ*fI;
            const v = v11 * (1-fJ)*(1-fI) + v12 * fJ*(1-fI) + v21 * (1-fJ)*fI + v22 * fJ*fI;
            
            const baseMag = Math.sqrt(u*u + v*v);
            const baseAngle = Math.atan2(u, v);
            
            const pU = baseMag * Math.sin(baseAngle);
            const pV = baseMag * Math.cos(baseAngle);

            p.prevX = p.x;
            p.prevY = p.y;
            p.x += pU * speedMultiplier;
            p.y -= pV * speedMultiplier; // Subtract because canvas Y is down

            ctx.beginPath();
            ctx.moveTo(p.prevX, p.prevY);
            ctx.lineTo(p.x, p.y);
            ctx.lineWidth = 2.0;
            ctx.stroke();
          }
        }

        p.age++;

        if (p.age > p.lifespan || p.x < 0 || p.x > width || p.y < 0 || p.y > height) {
          p.x = Math.random() * width;
          p.y = Math.random() * height;
          p.prevX = p.x;
          p.prevY = p.y;
          p.age = 0;
          p.lifespan = Math.floor(Math.random() * 100) + 50;
        }
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [currentData, currentMetricType, activeTab, isOpen]);

  useEffect(() => {
    if (isOpen) setShouldRender(true);
  }, [isOpen]);

  const handleAnimationComplete = () => {
    if (!isOpen) setShouldRender(false);
  };

  const [chartData, setChartData] = useState<{ date: string; value: number }[]>([]);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartLoading, setChartLoading] = useState(false);

  useEffect(() => {
    if (!currentData || !currentMetricType || !isOpen) return;
    
    setChartLoading(true);
    setChartError(null);
    setChartData([]);

    // Format date strictly as YYYY-MM-DD
    const isoDate = selectedDate.toISOString().split('T')[0];
    const lat = latRange ? latRange[0] : 0;
    const lon = lngRange ? lngRange[0] : 0;
    const metricStr = currentMetricType === 'Currents' || currentMetricType === 'Winds' ? currentMetricType + '_Magnitude' : currentMetricType;

    fetchHistoricalData(lat, lon, isoDate, metricStr)
      .then((res) => {
        if (res && res.time_series) {
           const formatted = res.time_series.map((item: any) => ({
             date: new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
             value: item.value
           }));
           setChartData(formatted);
        } else if (Array.isArray(res)) {
           const formatted = res.map((item: any) => ({
             date: new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
             value: item.value
           }));
           setChartData(formatted);
        } else {
           throw new Error("API payload did not contain a recognized history array.");
        }
      })
      .catch((err) => {
        setChartError(err.message || 'Failed to fetch historical data from backend.');
      })
      .finally(() => {
        setChartLoading(false);
      });
  }, [currentData, currentMetricType, selectedDate, isOpen, latRange, lngRange]);

  if (!shouldRender || !currentData || !currentMetricType) return null;

  const config = {
    'SST': { title: 'Sea Surface Temperature (SST)', color: '#ff7882', unit: '°C' },
    'SSS': { title: 'Sea Surface Salinity (SSS)', color: '#35b779', unit: ' psu' },
    'SSH': { title: 'Sea Surface Height (SSH)', color: '#8bb6d6', unit: 'm' },
    'Currents': { title: 'Surface Currents Magnitude', color: '#fde725', unit: ' m/s' },
    'Winds': { title: 'Surface Winds Magnitude', color: '#d4a5a5', unit: ' m/s' },
  }[currentMetricType];

  const effectiveTab = (currentMetricType === 'Currents' || currentMetricType === 'Winds') ? activeTab : 'magnitude';

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.05 } }}
          transition={{ duration: 0.3 }}
          onAnimationComplete={handleAnimationComplete}
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(2, 8, 16, 0.85)',
            backdropFilter: 'blur(12px)',
            zIndex: 99999,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300, delay: 0.1 }}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              width: '90%',
              maxWidth: '800px',
              height: '70vh',
              background: 'linear-gradient(145deg, rgba(16, 33, 54, 0.95), rgba(8, 16, 28, 0.95))',
              border: '1px solid rgba(139, 182, 214, 0.2)',
              borderRadius: '24px',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              padding: '24px 32px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
              background: 'rgba(0, 0, 0, 0.2)'
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '8px' }}>
                  <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: config.color, letterSpacing: '0.5px' }}>
                    {effectiveTab === 'direction' ? config.title.replace('Magnitude', 'Direction') : config.title}
                  </h2>
                  {(currentMetricType === 'Currents' || currentMetricType === 'Winds') && (
                    <div style={{ display: 'flex', background: 'rgba(0,0,0,0.4)', borderRadius: '12px', padding: '4px', border: '1px solid rgba(255,255,255,0.1)', boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.5)' }}>
                      <button
                        onClick={() => setActiveTab('magnitude')}
                        style={{
                          background: activeTab === 'magnitude' ? config.color : 'transparent',
                          color: activeTab === 'magnitude' ? '#000' : 'rgba(255,255,255,0.6)',
                          border: 'none', borderRadius: '8px', padding: '6px 16px', fontSize: '13px', cursor: 'pointer', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: 600,
                          boxShadow: activeTab === 'magnitude' ? `0 0 12px ${config.color}66` : 'none'
                        }}
                      >Magnitude</button>
                      <button
                        onClick={() => setActiveTab('direction')}
                        style={{
                          background: activeTab === 'direction' ? config.color : 'transparent',
                          color: activeTab === 'direction' ? '#000' : 'rgba(255,255,255,0.6)',
                          border: 'none', borderRadius: '8px', padding: '6px 16px', fontSize: '13px', cursor: 'pointer', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)', fontWeight: 600,
                          boxShadow: activeTab === 'direction' ? `0 0 12px ${config.color}66` : 'none'
                        }}
                      >Direction</button>
                    </div>
                  )}
                </div>
                <div style={{ fontSize: '13px', color: 'rgba(255, 255, 255, 0.5)' }}>
                  {effectiveTab === 'magnitude' ? (
                    latRange && lngRange 
                      ? `14-Day Historical Trend for Region: ${latRange[0]}°N - ${latRange[1]}°N, ${lngRange[0]}°E - ${lngRange[1]}°E`
                      : '14-Day Historical Trend'
                  ) : (
                    latRange && lngRange 
                      ? `Vector Field (0.25° Resolution) for Region: ${latRange[0]}°N - ${latRange[1]}°N, ${lngRange[0]}°E - ${lngRange[1]}°E`
                      : 'Vector Field (0.25° Resolution)'
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: 'rgba(255, 255, 255, 0.7)',
                  width: '40px',
                  height: '40px',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '20px',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 50, 50, 0.15)';
                  e.currentTarget.style.color = '#ff6b6b';
                  e.currentTarget.style.borderColor = 'rgba(255, 50, 50, 0.3)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                  e.currentTarget.style.color = 'rgba(255, 255, 255, 0.7)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                }}
              >
                ✕
              </button>
            </div>

            {/* Content */}
            <div style={{ flex: 1, padding: '32px', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {effectiveTab === 'magnitude' ? (
                chartLoading ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                      style={{
                        width: '32px', height: '32px',
                        border: '3px solid rgba(255,255,255,0.1)',
                        borderTopColor: config.color,
                        borderRadius: '50%'
                      }}
                    />
                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px', letterSpacing: '2px', fontWeight: 500 }}>
                      FETCHING ARCHIVE...
                    </span>
                  </div>
                ) : chartError ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ padding: '24px 32px', background: 'rgba(20, 0, 0, 0.8)', border: '1px solid rgba(255, 50, 50, 0.4)', borderRadius: '16px', maxWidth: '500px', textAlign: 'center' }}>
                      <h3 style={{ color: '#ff4444', margin: '0 0 12px 0', fontSize: '18px', fontWeight: 600 }}>API Data Error</h3>
                      <p style={{ color: 'rgba(255,255,255,0.8)', margin: 0, fontSize: '14px', lineHeight: '1.5' }}>{chartError}</p>
                    </div>
                  </div>
                ) : chartData.length === 0 ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ padding: '24px 32px', background: 'rgba(20, 0, 0, 0.8)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '16px', maxWidth: '500px', textAlign: 'center' }}>
                      <h3 style={{ color: 'rgba(255,255,255,0.9)', margin: '0 0 12px 0', fontSize: '18px', fontWeight: 600 }}>No Data Available</h3>
                      <p style={{ color: 'rgba(255,255,255,0.6)', margin: 0, fontSize: '14px', lineHeight: '1.5' }}>The backend API returned an empty dataset for {config.title} in this region and timeframe.</p>
                    </div>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 0, bottom: 0 }} style={{ outline: 'none' }}>
                    <defs>
                      <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={config.color} stopOpacity={0.4}/>
                        <stop offset="95%" stopColor={config.color} stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                    <XAxis 
                      dataKey="date" 
                      stroke="rgba(255,255,255,0.4)" 
                      tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 12 }} 
                      axisLine={false}
                      tickLine={false}
                      dy={10}
                    />
                    <YAxis 
                      stroke="rgba(255,255,255,0.4)" 
                      tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 12 }}
                      tickFormatter={(val) => `${val}${config.unit}`}
                      axisLine={false}
                      tickLine={false}
                      domain={['auto', 'auto']}
                      dx={-10}
                    />
                    <Tooltip 
                      contentStyle={{ background: 'rgba(10,25,45,0.95)', border: `1px solid ${config.color}`, borderRadius: '8px', fontSize: '12px' }}
                      itemStyle={{ color: '#fff' }}
                      formatter={(value: any) => [`${Number(value).toFixed(2)}${config.unit}`, 'Observed Value']}
                      labelStyle={{ color: 'rgba(255,255,255,0.7)', margin: '0 0 4px 0' }}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="value" 
                      stroke={config.color} 
                      strokeWidth={3}
                      fillOpacity={1} 
                      fill="url(#colorValue)" 
                      activeDot={{ r: 6, fill: config.color, stroke: '#fff', strokeWidth: 2 }}
                    />
                  </AreaChart>
                  </ResponsiveContainer>
                )
              ) : (
                <div style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0, paddingRight: '40px', paddingLeft: '40px' }}>
                  
                  {/* Canvas Container */}
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, minWidth: 0 }}>
                    <div style={{
                      width: '100%',
                      height: '100%',
                      maxWidth: '350px',
                      maxHeight: '350px',
                      aspectRatio: '1 / 1',
                      background: '#0f172a',
                      position: 'relative',
                      borderRadius: '8px',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                      border: '1px solid rgba(255,255,255,0.1)'
                    }}>
                      {/* Y-Axis (Latitude) */}
                      {latRange && (
                        <div style={{ position: 'absolute', left: '-40px', top: '-6px', bottom: '-6px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', color: 'rgba(255,255,255,0.6)', fontSize: '11px', fontWeight: 500, pointerEvents: 'none' }}>
                          <span>{latRange[1]}°N</span>
                          <span>{latRange[0]}°N</span>
                        </div>
                      )}
                      {/* X-Axis (Longitude) */}
                      {lngRange && (
                        <div style={{ position: 'absolute', bottom: '-24px', left: '-10px', right: '-10px', display: 'flex', justifyContent: 'space-between', color: 'rgba(255,255,255,0.6)', fontSize: '11px', fontWeight: 500, pointerEvents: 'none' }}>
                          <span>{lngRange[0]}°E</span>
                          <span>{lngRange[1]}°E</span>
                        </div>
                      )}
                      
                      <canvas
                        ref={canvasRef}
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'block',
                          borderRadius: '8px'
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ObservationModal;

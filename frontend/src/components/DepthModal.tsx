import React, { useState, useMemo, useRef, useEffect, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Text, Edges, Billboard, Html } from '@react-three/drei';
import * as THREE from 'three';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DepthModalProps {
  isOpen: boolean;
  onClose: () => void;
  predictions?: {
    depth: number;
    temps_celsius: number;
    temps_grid?: (number | null)[][];
  }[];
  latRange?: [number, number];
  lngRange?: [number, number];
  searchedLocation?: { lat: number; lon: number } | null;
}

// ─── Color Utilities ─────────────────────────────────────────────────────────

const getColorForTemp = (temp: number): THREE.Color => {
  const colorHot = new THREE.Color('#ffa500'); // Orange for warm (30°C)
  const colorCold = new THREE.Color('#4b0082'); // Indigo for cold (4°C)
  // Map roughly 4°C - 30°C to 0 - 1
  const ratio = Math.min(Math.max((temp - 4) / 26, 0), 1);
  return colorCold.clone().lerp(colorHot, ratio);
};



// ─── Topographic Surface Utils & Components ────────────────────────────────────

const getViridisColor = (t: number): THREE.Color => {
  // A simplified 5-stop Viridis colormap mapping 0..1
  const stops = [
    { p: 0.0, c: new THREE.Color('#440154') },
    { p: 0.25, c: new THREE.Color('#3b528b') },
    { p: 0.5, c: new THREE.Color('#21918c') },
    { p: 0.75, c: new THREE.Color('#5ec962') },
    { p: 1.0, c: new THREE.Color('#fde725') }
  ];
  
  if (t <= 0) return stops[0].c;
  if (t >= 1) return stops[4].c;
  
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].p && t <= stops[i+1].p) {
      const segmentT = (t - stops[i].p) / (stops[i+1].p - stops[i].p);
      return stops[i].c.clone().lerp(stops[i+1].c, segmentT);
    }
  }
  return stops[4].c;
};

interface SurfacePlotProps {
  layerData: (number | null)[][];
  baseTemp: number;
  zScale: number;
  latRange?: [number, number];
  lngRange?: [number, number];
  searchedLocation?: { lat: number; lon: number } | null;
}

const SurfacePlot: React.FC<SurfacePlotProps> = ({ layerData, baseTemp, zScale, latRange, lngRange, searchedLocation }) => {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => {
    // We expect layerData to be 20x20. We use a plane with 19x19 segments.
    // The width/height is 5x5 units to fit inside our scene.
    const size = 5;
    const gridRes = layerData.length; // usually 20
    const segments = gridRes - 1; // 19
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);

    // Get position and color attributes
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    // Compute min/max temp for accurate viridis normalization
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    for (let i = 0; i < gridRes; i++) {
      if (!layerData[i]) continue;
      for (let j = 0; j < layerData[i].length; j++) {
        const t = layerData[i][j];
        if (t !== null && t !== undefined) {
          if (t < minTemp) minTemp = t;
          if (t > maxTemp) maxTemp = t;
        }
      }
    }
    
    // Fallback if data is entirely uniform
    if (maxTemp === minTemp) {
      maxTemp = minTemp + 0.1;
    }

    const midTemp = (minTemp + maxTemp) / 2;

    for (let y = 0; y < gridRes; y++) {
      if (!layerData[y]) continue;
      for (let x = 0; x < gridRes; x++) {
        // PlaneGeometry vertex row 0 is +Y (North), which matches layerData[0]
        const i = y * gridRes + x; 
        
        let t = layerData[y][x];
        const isLand = (t === null || t === undefined);
        
        let zHeight = 0;
        let vertexColor = new THREE.Color();

        if (isLand) {
          zHeight = 0;
          vertexColor = new THREE.Color('#333333'); // Distinct flat gray for landmass
        } else {
          zHeight = (t - midTemp) * zScale;
          const normalized = Math.max(0, Math.min(1, (t - minTemp) / (maxTemp - minTemp)));
          vertexColor = getViridisColor(normalized);
        }

        // Apply Z height
        pos.setZ(i, zHeight);
        
        // Apply Color
        colors[i * 3] = vertexColor.r;
        colors[i * 3 + 1] = vertexColor.g;
        colors[i * 3 + 2] = vertexColor.b;
      }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }, [layerData, baseTemp, zScale]);

  const pinData = useMemo(() => {
    if (!searchedLocation || !latRange || !lngRange) return null;
    const { lat, lon } = searchedLocation;
    if (lat < latRange[0] || lat > latRange[1] || lon < lngRange[0] || lon > lngRange[1]) return null;
    
    const gridRes = layerData.length;
    let minTemp = Infinity;
    let maxTemp = -Infinity;
    for (let i = 0; i < gridRes; i++) {
      if (!layerData[i]) continue;
      for (let j = 0; j < layerData[i].length; j++) {
        const t = layerData[i][j];
        if (t !== null && t !== undefined) {
          if (t < minTemp) minTemp = t;
          if (t > maxTemp) maxTemp = t;
        }
      }
    }
    if (maxTemp === minTemp) { maxTemp = minTemp + 0.1; }
    const midTemp = (minTemp + maxTemp) / 2;

    const size = 5;
    const x = ((lon - lngRange[0]) / (lngRange[1] - lngRange[0]) - 0.5) * size;
    const y = ((lat - latRange[0]) / (latRange[1] - latRange[0]) - 0.5) * size;

    const colFloat = ((lon - lngRange[0]) / (lngRange[1] - lngRange[0])) * (gridRes - 1);
    const rowFloat = ((latRange[1] - lat) / (latRange[1] - latRange[0])) * (gridRes - 1);

    const colFloor = Math.max(0, Math.min(gridRes - 1, Math.floor(colFloat)));
    const rowFloor = Math.max(0, Math.min(gridRes - 1, Math.floor(rowFloat)));
    const colCeil = Math.min(gridRes - 1, colFloor + 1);
    const rowCeil = Math.min(gridRes - 1, rowFloor + 1);

    const u = colFloat - colFloor;
    const v = rowFloat - rowFloor;

    const t00 = layerData[rowFloor]?.[colFloor] ?? null; // top-left (a)
    const t10 = layerData[rowFloor]?.[colCeil] ?? null;  // top-right (d)
    const t01 = layerData[rowCeil]?.[colFloor] ?? null;  // bottom-left (b)
    const t11 = layerData[rowCeil]?.[colCeil] ?? null;   // bottom-right (c)

    if (t00 === null || t10 === null || t01 === null || t11 === null) return null; // Landmass

    // Three.js PlaneGeometry splits quads into two flat triangles.
    // The diagonal goes from bottom-left (b) to top-right (d).
    // u + v <= 1 is the top-left triangle (a, b, d)
    let exactTemp;
    if (u + v <= 1) {
      exactTemp = t00 + u * (t10 - t00) + v * (t01 - t00);
    } else {
      // bottom-right triangle (c, d, b)
      exactTemp = t11 + (1 - u) * (t01 - t11) + (1 - v) * (t10 - t11);
    }

    const surfaceZ = (exactTemp - midTemp) * zScale;
    return { x, y, z: surfaceZ, temp: exactTemp };
  }, [searchedLocation, latRange, lngRange, layerData, zScale]);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh ref={meshRef} geometry={geometry}>
        <meshStandardMaterial
          vertexColors
          roughness={0.2}
          metalness={0.3}
          side={THREE.DoubleSide}
        />
      </mesh>
      
      {pinData && (
        <group position={[pinData.x, pinData.y, pinData.z + 1.5]} rotation={[Math.PI / 2, 0, 0]}>
          <mesh>
            <cylinderGeometry args={[0.015, 0.015, 3, 8]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          <mesh position={[0, 1.5, 0]}>
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshStandardMaterial color="#ef4444" roughness={0.2} metalness={0.1} />
          </mesh>
          <Html position={[0, 1.65, 0]} center>
            <div style={{
              color: 'white',
              fontSize: '14px',
              fontWeight: 500,
              filter: 'drop-shadow(0 2px 2px rgba(0,0,0,0.8))',
              whiteSpace: 'nowrap'
            }}>
              {pinData.temp.toFixed(2)} °C
            </div>
          </Html>
        </group>
      )}
    </group>
  );
};

const SurfaceAxes = ({ size = 5, latRange = [10, 15], lngRange = [85, 90] }) => {
  const half = size / 2;
  const numSteps = 5;

  const latStep = (latRange[1] - latRange[0]) / numSteps;
  const lngStep = (lngRange[1] - lngRange[0]) / numSteps;

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      {/* Base Grid at Z=0 (mid-temp height) */}
      <gridHelper 
        args={[size, 20, 0xffffff, 0xffffff]} 
        position={[0, 0, 0]} 
        rotation={[Math.PI / 2, 0, 0]}
        material-opacity={0.15} 
        material-transparent 
      />

      {/* Latitude Labels (Left Edge) */}
      {Array.from({ length: numSteps + 1 }).map((_, i) => {
        const yPos = half - (i * (size / numSteps));
        const val = latRange[1] - (i * latStep);
        return (
          <Text
            key={`lat-${i}`}
            position={[-half - 0.4, yPos, 0]}
            fontSize={0.15}
            color="rgba(255, 255, 255, 0.8)"
            anchorX="right"
            anchorY="middle"
          >
            {val.toFixed(1)}°N
          </Text>
        );
      })}

      {/* Longitude Labels (Bottom Edge) */}
      {Array.from({ length: numSteps + 1 }).map((_, i) => {
        const xPos = -half + (i * (size / numSteps));
        const val = lngRange[0] + (i * lngStep);
        return (
          <Text
            key={`lng-${i}`}
            position={[xPos, -half - 0.4, 0]}
            fontSize={0.15}
            color="rgba(255, 255, 255, 0.8)"
            anchorX="center"
            anchorY="top"
          >
            {val.toFixed(1)}°E
          </Text>
        );
      })}
    </group>
  );
};

const SurfaceColorbar = () => (
  <div style={{
    position: 'absolute', right: '32px', top: '50%', transform: 'translateY(-50%)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
    background: 'rgba(0, 0, 0, 0.4)', padding: '16px 12px', borderRadius: '16px',
    border: '1px solid rgba(255, 255, 255, 0.1)', backdropFilter: 'blur(4px)', pointerEvents: 'none'
  }}>
    <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '12px', fontWeight: 600 }}>High</span>
    <div style={{
      width: '12px', height: '180px',
      background: 'linear-gradient(to bottom, #fde725, #5ec962, #21918c, #3b528b, #440154)',
      borderRadius: '6px', boxShadow: 'inset 0 0 4px rgba(0,0,0,0.5)'
    }} />
    <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '12px', fontWeight: 600 }}>Low</span>
    <span style={{ color: '#8bb6d6', fontSize: '11px', marginTop: '4px', letterSpacing: '0.5px', fontWeight: 500 }}>TEMP</span>
  </div>
);

const SurfaceInfoOverlay = ({ depth, baseTemp }: { depth: number; baseTemp: number }) => (
  <div style={{
    position: 'absolute', left: '32px', bottom: '32px',
    background: 'rgba(20, 0, 0, 0.6)', padding: '16px', borderRadius: '12px',
    border: '1px solid rgba(255, 255, 255, 0.1)', backdropFilter: 'blur(8px)', pointerEvents: 'none'
  }}>
    <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#fff', letterSpacing: '1px', textTransform: 'uppercase' }}>
      Topographic Surface at {depth}m
    </h3>
    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Grid Res:</span> 20x20 (0.25° cells)</div>
      <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Base Temp:</span> {baseTemp.toFixed(1)}°C</div>
      <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Null Handling:</span> Landmass Flattening</div>
    </div>
  </div>
);

const SurfaceZScaleSlider = ({ zScale, setZScale }: { zScale: number; setZScale: (val: number) => void }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(zScale.toString());

  const handleBlurOrSubmit = () => {
    setIsEditing(false);
    const parsed = parseFloat(inputValue);
    if (!isNaN(parsed) && parsed > 0) {
      setZScale(parsed);
    } else {
      setInputValue(zScale.toFixed(1));
    }
  };

  return (
    <div style={{
      position: 'absolute', left: '32px', top: '50%', transform: 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
      background: 'rgba(10, 15, 25, 0.6)', padding: '12px 8px', borderRadius: '12px',
      border: '1px solid rgba(139, 182, 214, 0.2)', backdropFilter: 'blur(12px)',
      boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.3)'
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '9px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Z-Scale</span>
        {isEditing ? (
          <input
            type="text"
            autoFocus
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={handleBlurOrSubmit}
            onKeyDown={(e) => e.key === 'Enter' && handleBlurOrSubmit()}
            style={{
              width: '32px',
              background: 'rgba(0,0,0,0.5)',
              border: '1px solid #8bb6d6',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '11px',
              textAlign: 'center',
              outline: 'none',
              padding: '2px 0'
            }}
          />
        ) : (
          <span 
            onClick={() => { setIsEditing(true); setInputValue(zScale.toFixed(1)); }}
            style={{ color: '#8bb6d6', fontSize: '13px', fontWeight: 700, cursor: 'text' }}
          >
            {zScale.toFixed(1)}x
          </span>
        )}
      </div>
    
    <div style={{ position: 'relative', width: '20px', height: '140px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <style>{`
        .sleek-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 120px;
          height: 3px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 2px;
          outline: none;
          transform: rotate(-90deg);
          cursor: pointer;
        }
        .sleek-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #8bb6d6;
          cursor: pointer;
          transition: all 0.2s ease;
          box-shadow: 0 0 10px rgba(139, 182, 214, 0.5);
        }
        .sleek-slider::-webkit-slider-thumb:hover {
          transform: scale(1.3);
          box-shadow: 0 0 15px rgba(139, 182, 214, 0.8);
        }
      `}</style>
      <input
        type="range"
        min="0.1"
        max="5.0"
        step="0.1"
        value={zScale}
        onChange={(e) => setZScale(parseFloat(e.target.value))}
        className="sleek-slider"
      />
    </div>
  </div>
  );
};

// ─── Existing Components ────────────────────────────────────────────────────

interface LayerProps {
  depth: number;
  temp: number;
  index: number;
  onClick: () => void;
}

const Layer: React.FC<LayerProps> = ({ depth, temp, onClick }) => {
  const [hovered, setHovered] = useState(false);
  const meshRef = useRef<THREE.Mesh>(null);
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);

  // Rounded rectangle shape
  const roundedRectShape = useMemo(() => {
    const w = 6, h = 6, r = 0.4;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo(w / 2 - r, -h / 2);
    shape.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, false);
    shape.lineTo(w / 2, h / 2 - r);
    shape.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, false);
    shape.lineTo(-w / 2 + r, h / 2);
    shape.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, false);
    return shape;
  }, []);

  // Use a logarithmic scale to smoothly separate the shallow layers.
  // Math.log(depth / 40 + 1) ensures 0m to 5m doesn't have a massive jump, 
  // keeping the gap near 0.32 units, which perfectly fits the 0.25 font size.
  const normalizedDepth = Math.log(depth / 40 + 1) / Math.log(1000 / 40 + 1);
  const yPos = 4.5 - (normalizedDepth * 9); // Scale total height to 9 units (4.5 to -4.5)
  const color = getColorForTemp(temp);

  return (
    <group position={[0, yPos, 0]}>
      <mesh
        ref={meshRef}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          pointerDownPos.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          if (!pointerDownPos.current) return;
          const dx = e.clientX - pointerDownPos.current.x;
          const dy = e.clientY - pointerDownPos.current.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          pointerDownPos.current = null;
          // Only count as a click if pointer barely moved (not a drag/orbit)
          if (distance < 5) {
            onClick();
          }
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <shapeGeometry args={[roundedRectShape]} />
        <meshPhysicalMaterial
          color={color}
          transparent
          opacity={hovered ? 0.85 : 0.65}
          roughness={0.2}
          metalness={0.1}
          clearcoat={0.8}
          clearcoatRoughness={0.2}
          side={THREE.DoubleSide}
          emissive={hovered ? color : new THREE.Color('#000000')}
          emissiveIntensity={hovered ? 0.3 : 0}
        />
        <Edges linewidth={1} color="#ffffff" transparent opacity={0.2} />
      </mesh>

      {/* Hover ring indicator */}
      {hovered && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[2.8, 3.0, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.4} side={THREE.DoubleSide} />
        </mesh>
      )}

      <group
        position={[-3.2, 0, 3.2]}
        onPointerDown={(e) => {
          e.stopPropagation();
          pointerDownPos.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          if (!pointerDownPos.current) return;
          const dx = e.clientX - pointerDownPos.current.x;
          const dy = e.clientY - pointerDownPos.current.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          pointerDownPos.current = null;
          if (distance < 5) onClick();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <Billboard>
          <Text
            fontSize={hovered ? 0.28 : 0.22}
            color={hovered ? '#00ff88' : '#ffffff'}
            fillOpacity={hovered ? 1 : 0.9}
            fontWeight={hovered ? 700 : 400}
            anchorX="right"
            anchorY="middle"
          >
            {`${depth}m`}
          </Text>
        </Billboard>
      </group>
      <group
        position={[3.2, 0, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          pointerDownPos.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          if (!pointerDownPos.current) return;
          const dx = e.clientX - pointerDownPos.current.x;
          const dy = e.clientY - pointerDownPos.current.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          pointerDownPos.current = null;
          if (distance < 5) onClick();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <Billboard>
          <Text
            fontSize={hovered ? 0.28 : 0.22}
            color={hovered ? '#00ff88' : '#ffffff'}
            fillOpacity={hovered ? 1 : 0.9}
            fontWeight={hovered ? 700 : 400}
            anchorX="left"
            anchorY="middle"
          >
            {`${temp.toFixed(1)}°C`}
          </Text>
        </Billboard>
      </group>
    </group>
  );
};



// ─── Raycast Fixer ─────────────────────────────────────────────────────────────
// Fixes R3F raycasting offset when CSS 100% scaling overrides the internal buffer size
const RaycastFixer = () => {
  const setEvents = useThree((state) => state.setEvents);
  const get = useThree((state) => state.get);
  
  useEffect(() => {
    const defaultCompute = get().events.compute;
    setEvents({
      compute: (event: any, state: any) => {
        const nativeEvent = event.nativeEvent || event;
        const { clientX, clientY } = nativeEvent;
        
        if (clientX === undefined) {
          if (defaultCompute) return defaultCompute(event, state);
          return;
        }
        
        const rect = state.gl.domElement.getBoundingClientRect();
        state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        state.raycaster.setFromCamera(state.pointer, state.camera);
      }
    });
    
    return () => {
      if (defaultCompute) {
        setEvents({ compute: defaultCompute });
      }
    };
  }, [setEvents, get]);
  
  return null;
};

// ─── Main DepthModal Component ──────────────────────────────────────────────

const DepthModal: React.FC<DepthModalProps> = ({ isOpen, onClose, predictions, latRange, lngRange, searchedLocation }) => {
  const [selectedLayer, setSelectedLayer] = useState<number | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(isOpen);
  const [zScale, setZScale] = useState(2.5);
  const [autoRotate, setAutoRotate] = useState(true);
  const backdropPointerDown = useRef(false);

  // Sync state with isOpen prop to prevent 1-frame flash
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setIsProfileLoading(true);
      setAutoRotate(true);
    } else {
      setSelectedLayer(null);
      setIsProfileLoading(false);
    }
  }

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        setIsProfileLoading(false);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleLayerClick = (depth: number) => {
    setSelectedLayer(depth);
    setAutoRotate(true);
  };

  const handleBack = () => {
    setSelectedLayer(null);
  };

  const isSurfaceView = selectedLayer !== null;
  const selectedLayerData = useMemo(() => {
    if (!predictions || selectedLayer === null) return null;
    return predictions.find((p) => p.depth === selectedLayer) || null;
  }, [predictions, selectedLayer]);
  
  const hasValidGrid = selectedLayerData?.temps_grid && selectedLayerData.temps_grid.length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 100,
            paddingRight: '350px'
          }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) {
              backdropPointerDown.current = true;
            }
          }}
          onPointerUp={(e) => {
            if (backdropPointerDown.current && e.target === e.currentTarget) {
              onClose();
            }
            backdropPointerDown.current = false;
          }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            style={{
              width: '90%',
              maxWidth: '900px',
              height: '80%',
              maxHeight: '700px',
              display: 'flex',
              flexDirection: 'column',
              borderRadius: '24px',
              overflow: 'hidden',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
              border: '1px solid rgba(255, 255, 255, 0.1)'
            }}
            className="glass-panel"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              padding: '24px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.05)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {/* Back button when in surface view */}
                <AnimatePresence>
                  {isSurfaceView && (
                    <motion.button
                      initial={{ opacity: 0, x: -10, scale: 0.9 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: -10, scale: 0.9 }}
                      transition={{ duration: 0.2 }}
                      onClick={handleBack}
                      className="pill-button"
                      style={{
                        padding: '6px 14px',
                        fontSize: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: 'rgba(139, 182, 214, 0.2)',
                        border: '1px solid rgba(139, 182, 214, 0.4)',
                        color: '#8bb6d6',
                      }}
                    >
                      ← Back
                    </motion.button>
                  )}
                </AnimatePresence>

                <h2 style={{ margin: 0, fontSize: '20px', color: '#8bb6d6', fontWeight: 500 }}>
                  {isSurfaceView
                    ? `Thermocline Surface — ${selectedLayer}m`
                    : 'Subsurface 3D Profile'
                  }
                </h2>
              </div>
              <button
                onClick={onClose}
                className="pill-button"
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                Close
              </button>
            </div>

            {/* 3D Canvas Area */}
            <div className="depth-modal-canvas-container" style={{ flex: 1, position: 'relative' }}>
              <style>{`
                .depth-modal-canvas-container canvas {
                  width: 100% !important;
                  height: 100% !important;
                }
              `}</style>
              <AnimatePresence mode="wait">
                {isProfileLoading ? (
                  <motion.div
                    key="profile-loader"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}
                  >
                    <div style={{
                      width: '40px', height: '40px',
                      borderRadius: '50%',
                      border: '3px solid rgba(139, 182, 214, 0.2)',
                      borderTopColor: '#8bb6d6',
                      animation: 'spin 1s linear infinite'
                    }} />
                    <span style={{ color: '#8bb6d6', fontSize: '13px', fontWeight: 500, letterSpacing: '1px' }}>
                      RENDERING 3D SUBSURFACE PROFILE...
                    </span>
                    <style>{`
                      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    `}</style>
                  </motion.div>
                ) : (!predictions || predictions.length === 0) ? (
                  /* ── Error Barrier View for Missing Profile Data ── */
                  <motion.div
                    key="profile-error"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.35, ease: 'easeInOut' }}
                    style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center', background: 'rgba(255, 0, 0, 0.05)' }}
                  >
                    <div style={{
                      padding: '24px 32px',
                      background: 'rgba(20, 0, 0, 0.8)',
                      border: '1px solid rgba(255, 50, 50, 0.4)',
                      borderRadius: '16px',
                      boxShadow: '0 10px 30px -10px rgba(255,0,0,0.3)',
                      maxWidth: '500px',
                    }}>
                      <h3 style={{ color: '#ff4444', margin: '0 0 16px 0', fontSize: '20px', fontWeight: 600 }}>Data Unavailable</h3>
                      <p style={{ color: 'rgba(255,255,255,0.8)', margin: 0, fontSize: '15px', lineHeight: '1.6' }}>
                        Subsurface profile data is not available for this location.
                        <br /><br />
                        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>The mock engine has been permanently removed per architectural guidelines.</span>
                      </p>
                    </div>
                  </motion.div>
                ) : isSurfaceView ? (
                  !hasValidGrid ? (
                    /* ── Error Barrier View for Missing Grid ── */
                    <motion.div
                      key="surface-error"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.35, ease: 'easeInOut' }}
                      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center', background: 'rgba(255, 0, 0, 0.05)' }}
                    >
                      <div style={{
                        padding: '24px 32px',
                        background: 'rgba(20, 0, 0, 0.8)',
                        border: '1px solid rgba(255, 50, 50, 0.4)',
                        borderRadius: '16px',
                        boxShadow: '0 10px 30px -10px rgba(255,0,0,0.3)',
                        maxWidth: '500px',
                      }}>
                        <h3 style={{ color: '#ff4444', margin: '0 0 16px 0', fontSize: '20px', fontWeight: 600 }}>Data Unavailable</h3>
                        <p style={{ color: 'rgba(255,255,255,0.8)', margin: 0, fontSize: '15px', lineHeight: '1.6' }}>
                          High-resolution spatial temperature grids for depth layers are not provided by the current backend API payload.
                          <br /><br />
                          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>The mock engine has been permanently removed per architectural guidelines.</span>
                        </p>
                      </div>
                    </motion.div>
                  ) : (
                    /* ── Topographic Surface View ── */
                    <motion.div
                      key="topographic-view"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.35, ease: 'easeInOut' }}
                      style={{ position: 'absolute', inset: 0 }}
                    >
                      <Canvas style={{ width: '100%', height: '100%' }} camera={{ position: [5, 4, 5], fov: 50 }}>
                        <RaycastFixer />
                        <ambientLight intensity={0.4} />
                        <directionalLight position={[10, 10, 5]} intensity={1.5} />
                        <pointLight position={[-10, -10, -10]} color="#4b0082" intensity={2} />
                        <OrbitControls 
                          makeDefault 
                          enableDamping 
                          dampingFactor={0.05} 
                          autoRotate={autoRotate}
                          autoRotateSpeed={1.0}
                          onStart={() => setAutoRotate(false)}
                        />
                        <Suspense fallback={null}>
                          <SurfacePlot 
                            layerData={selectedLayerData!.temps_grid!} 
                            baseTemp={selectedLayerData!.temps_celsius} 
                            zScale={zScale}
                            latRange={latRange}
                            lngRange={lngRange}
                            searchedLocation={searchedLocation}
                          />
                          <SurfaceAxes size={5} latRange={latRange} lngRange={lngRange} />
                        </Suspense>
                      </Canvas>
                      <SurfaceColorbar />
                      <SurfaceZScaleSlider zScale={zScale} setZScale={setZScale} />
                      <SurfaceInfoOverlay depth={selectedLayer!} baseTemp={selectedLayerData!.temps_celsius} />
                    </motion.div>
                  )
                ) : (
                  /* ── Stacked Planes View ── */
                  <motion.div
                    key="stacked-view"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.35, ease: 'easeInOut' }}
                    style={{ position: 'absolute', inset: 0 }}
                  >
                    <Canvas style={{ width: '100%', height: '100%' }} camera={{ position: [8, 5, 8], fov: 50 }}>
                      <RaycastFixer />
                      <ambientLight intensity={0.4} />
                      <directionalLight position={[10, 10, 5]} intensity={1.5} />
                      <pointLight position={[-10, -10, -10]} color="#4b0082" intensity={2} />
                      <spotLight position={[0, 10, 0]} angle={0.5} penumbra={1} intensity={1} />
                      <OrbitControls makeDefault enableDamping dampingFactor={0.05} />
                      <Suspense fallback={null}>
                        <group position={[-1.5, 0, 0]}>
                          {predictions?.map((pred, index) => (
                            <Layer
                              key={pred.depth}
                              depth={pred.depth}
                              temp={pred.temps_celsius}
                              index={index}
                              onClick={() => handleLayerClick(pred.depth)}
                            />
                          ))}
                        </group>
                      </Suspense>
                    </Canvas>

                    {/* Colorbar Legend Overlay */}
                    <div style={{
                      position: 'absolute',
                      right: '32px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '8px',
                      background: 'rgba(0, 0, 0, 0.4)',
                      padding: '16px 12px',
                      borderRadius: '16px',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      backdropFilter: 'blur(4px)',
                      pointerEvents: 'none'
                    }}>
                      <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '12px', fontWeight: 600 }}>30°C</span>
                      <div style={{
                        width: '12px',
                        height: '180px',
                        background: 'linear-gradient(to bottom, #ffa500, #4b0082)',
                        borderRadius: '6px',
                        boxShadow: 'inset 0 0 4px rgba(0,0,0,0.5)'
                      }} />
                      <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '12px', fontWeight: 600 }}>4°C</span>
                      <span style={{ color: '#8bb6d6', fontSize: '11px', marginTop: '4px', letterSpacing: '0.5px', fontWeight: 500 }}>TEMP</span>
                    </div>

                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Hint footer — below the canvas area */}
            {!isSurfaceView && (
              <div style={{
                padding: '10px 0',
                textAlign: 'center',
                background: 'rgba(255,255,255,0.03)',
                borderTop: '1px solid rgba(255,255,255,0.06)',
              }}>
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px' }}>
                  Click any layer to explore its temperature surface
                </span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default DepthModal;
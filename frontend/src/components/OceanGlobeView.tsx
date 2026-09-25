import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import Globe from 'react-globe.gl';
import type { GlobeMethods } from 'react-globe.gl';
import * as THREE from 'three';
import { Suspense, lazy } from 'react';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { motion } from 'framer-motion';
const DepthModal = lazy(() => import('./DepthModal'));
const ValidationModal = lazy(() => import('./ValidationModal'));
const ObservationModal = lazy(() => import('./ObservationModal'));
import CoordinateSearch from './CoordinateSearch';
import DateStepper from './DateStepper';
import { fetchOceanProfile, fetchOceanTask, formatDateKey, NetworkError, ApiDataError, checkBackendHealth } from '../services/api';
import type { OceanDataResponse } from '../services/api';
import { Target, ThermometerSun, Droplets, Waves, Navigation, Wind, Calendar, WifiOff, RefreshCw } from 'lucide-react';
import LoadingBg from '../assets/images/Loading-Background.webp';
import Logo from '../assets/logo.svg';

interface GeoJsonGeometry {
  type: string;
  coordinates: any[];
}

interface Feature {
  type: 'Feature';
  geometry: GeoJsonGeometry;
  properties: any;
}

interface LabelData {
  text: string;
  lat: number;
  lng: number;
  size: number;
  color: string;
  isOcean?: boolean;
}

const OCEANS: LabelData[] = [
  { text: 'Indian Ocean', lat: -10, lng: 75, size: 2, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'South Atlantic Ocean', lat: -20, lng: -15, size: 2, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'North Atlantic Ocean', lat: 30, lng: -40, size: 2, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'Pacific Ocean', lat: 0, lng: -150, size: 2, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'Southern Ocean', lat: -60, lng: 90, size: 2, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'Arctic Ocean', lat: 80, lng: 0, size: 2, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'Arabian Sea', lat: 15, lng: 65, size: 1.5, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'Bay of Bengal', lat: 15, lng: 90, size: 1.5, color: 'rgba(50, 50, 50, 0.6)', isOcean: true },
  { text: 'Mediterranean Sea', lat: 35, lng: 18, size: 1.2, color: 'rgba(50, 50, 50, 0.6)', isOcean: true }
];

const OceanGlobeView: React.FC = () => {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const reqIdRef = useRef<number | null>(null);
  const isIntroPlaying = useRef<boolean>(true);
  const [landPolygons, setLandPolygons] = useState<Feature[]>([]);
  const [labels, setLabels] = useState<LabelData[]>(OCEANS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [focusedRegion, setFocusedRegion] = useState<'bob' | 'as' | null>(null);
  const focusedRegionRef = useRef<'bob' | 'as' | null>(null);
  const isFlightAnimatingRef = useRef<boolean>(false);
  const flightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupMouseRef = useRef<(() => void) | null>(null);
  const [clickedCell, setClickedCell] = useState<{ minLat: number; maxLat: number; minLng: number; maxLng: number } | null>(null);
  const [hoveredCell, setHoveredCell] = useState<Feature | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchedLocation, setSearchedLocation] = useState<{ lat: number; lon: number } | null>(null);
  const searchedLocationRef = useRef<{ lat: number; lon: number } | null>(null);
  const [isValidationModalOpen, setIsValidationModalOpen] = useState(false);
  const [activeObservation, setActiveObservation] = useState<'SST' | 'SSS' | 'SSH' | 'Currents' | 'Winds' | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => new Date('2024-12-15T00:00:00'));

  // ── Live API state ─────────────────────────────────────────────────────────
  const [oceanData, setOceanData] = useState<OceanDataResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [pollProgress, setPollProgress] = useState(0);
  const [fetchError, setFetchError] = useState<{ type: 'network' | 'no-data'; message: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const triggerFetch = useCallback((lat: number, lon: number, date: Date) => {
    // Cancel any previous in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setIsPolling(false);
    setPollProgress(0);
    setOceanData(null);
    setFetchError(null);

    fetchOceanProfile(lat, lon, formatDateKey(date), controller.signal)
      .then((data) => {
        if ('task_id' in data) {
          // Setup polling
          setIsPolling(true);
          setPollProgress(data.progress || 0);

          const pollInterval = setInterval(() => {
            fetchOceanTask(data.task_id, lat, lon, formatDateKey(date), controller.signal)
              .then((taskData) => {
                if (abortControllerRef.current !== controller) {
                  clearInterval(pollInterval);
                  return;
                }
                setPollProgress(taskData.progress || 0);
                if (taskData.status === 'completed' && taskData.result) {
                  clearInterval(pollInterval);
                  setPollProgress(100);
                  setTimeout(() => {
                    if (abortControllerRef.current !== controller) return;
                    // Safely cast to prevent TS closure complaints
                    setOceanData(taskData.result as any);
                    setIsPolling(false);
                    setIsLoading(false);
                  }, 600);
                } else if (taskData.status === 'failed') {
                  clearInterval(pollInterval);
                  setFetchError({ type: 'network', message: 'Task processing failed on the server.' });
                  setIsPolling(false);
                  setIsLoading(false);
                }
              })
              .catch((err) => {
                if (err instanceof DOMException && err.name === 'AbortError') {
                  clearInterval(pollInterval);
                  return;
                }
                clearInterval(pollInterval);
                setFetchError({ type: 'network', message: 'Polling connection failed.' });
                setIsPolling(false);
                setIsLoading(false);
              });
          }, 1000);

          // Cleanup pollInterval on abort
          controller.signal.addEventListener('abort', () => clearInterval(pollInterval));
        } else {
          // Data is already cached and returned instantly
          setOceanData(data as OceanDataResponse);
          setIsLoading(false);
          setFetchError(null);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return; // deliberate cancel
        setIsLoading(false);
        setIsPolling(false);
        if (err instanceof NetworkError) {
          setFetchError({ type: 'network', message: err.message });
        } else if (err instanceof ApiDataError) {
          setFetchError({ type: 'no-data', message: err.message });
        } else {
          setFetchError({ type: 'network', message: 'An unexpected error occurred.' });
        }
      });
  }, []);

  // Trigger fetch whenever the clicked cell or selected date changes
  useEffect(() => {
    if (!clickedCell || !focusedRegion) {
      setOceanData(null);
      setFetchError(null);
      return;
    }

    const timer = setTimeout(() => {
      triggerFetch(clickedCell.minLat, clickedCell.minLng, selectedDate);
    }, 400);

    return () => {
      clearTimeout(timer);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clickedCell, selectedDate]);

  useEffect(() => {
    searchedLocationRef.current = searchedLocation;
  }, [searchedLocation]);

  const triggerFlight = useCallback((target: { lat: number; lng: number; altitude: number }, duration: number, disablePointerEvents: boolean = true) => {
    if (!globeRef.current) return;

    // Stop any existing flight to prevent tween collisions/jitter
    const currentPov = globeRef.current.pointOfView();
    globeRef.current.pointOfView({ lat: currentPov.lat, lng: currentPov.lng, altitude: currentPov.altitude }, 0);

    // Start new flight
    setTimeout(() => {
      if (globeRef.current) {
        globeRef.current.pointOfView(target, duration);
      }
    }, 10);

    if (disablePointerEvents) {
      isFlightAnimatingRef.current = true;
      if (flightTimeoutRef.current) clearTimeout(flightTimeoutRef.current);

      flightTimeoutRef.current = setTimeout(() => {
        isFlightAnimatingRef.current = false;
      }, duration + 10);
    }
  }, []);

  const [isGlobeReady, setIsGlobeReady] = useState(false);
  const [isMapDataLoaded, setIsMapDataLoaded] = useState(false);
  const [isBgLoaded, setIsBgLoaded] = useState(false);
  const [showLoading, setShowLoading] = useState(true);
  const [fadeOutLoading, setFadeOutLoading] = useState(false);
  const [introFinished, setIntroFinished] = useState(false);
  const [backendHealthy, setBackendHealthy] = useState<boolean | null>(null);

  const checkHealth = useCallback(async () => {
    setBackendHealthy(null);
    const healthy = await checkBackendHealth();
    setBackendHealthy(healthy);
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Geographic bounds for clickable grid cells
  const REGION_BOUNDS = {
    bob: { minLat: 5, maxLat: 25, minLng: 80, maxLng: 100 },  // Bay of Bengal
    as: { minLat: 5, maxLat: 25, minLng: 50, maxLng: 80 },   // Arabian Sea
  };

  useEffect(() => {
    const preventNativeZoom = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault(); // Prevents trackpad pinch-to-zoom from zooming the browser UI
      }
    };
    window.addEventListener('wheel', preventNativeZoom, { passive: false });

    return () => {
      window.removeEventListener('wheel', preventNativeZoom);
      if (reqIdRef.current) cancelAnimationFrame(reqIdRef.current);
      if (cleanupMouseRef.current) cleanupMouseRef.current();
    };
  }, []);

  useEffect(() => {
    if (globeRef.current) {
      const controls = globeRef.current.controls();
      if (controls) {
        controls.enableRotate = !focusedRegion;
        controls.enableZoom = !focusedRegion;
      }
    }
  }, [focusedRegion]);

  useEffect(() => {
    fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson')
      .then(res => res.json())
      .then(data => {
        setLandPolygons(data.features);

        const countryLabels: LabelData[] = data.features
          .filter((d: Feature) => d.properties.LABEL_Y && d.properties.LABEL_X && d.properties.NAME)
          .map((d: Feature) => ({
            text: d.properties.NAME,
            lat: d.properties.LABEL_Y,
            lng: d.properties.LABEL_X,
            size: 1.2,
            color: 'rgba(100, 100, 100, 0.8)',
            isOcean: false
          }));

        setLabels([...OCEANS, ...countryLabels]);
        setIsMapDataLoaded(true);
      })
      .catch(err => {
        console.error("Failed to load map data:", err);
        setIsMapDataLoaded(true);
      });

    setIsBgLoaded(true);
  }, []);

  const isFullyLoaded = isGlobeReady && isMapDataLoaded && isBgLoaded && backendHealthy === true;

  useEffect(() => {
    if (isFullyLoaded) {
      setTimeout(() => {
        setFadeOutLoading(true);
        setTimeout(() => {
          setShowLoading(false);
          if (globeRef.current) {
            triggerFlight({ lat: 5, lng: 80, altitude: 0.8 }, 4000, false);
            setTimeout(() => {
              isIntroPlaying.current = false;
              setIntroFinished(true);
              if (globeRef.current) {
                globeRef.current.controls().maxDistance = 240;
              }
            }, 4000);
          }
        }, 800);
      }, 500);
    }
  }, [isFullyLoaded]);

  const globeMaterial = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Create vertical gradient (poles to equator to poles) for aesthetic ocean depth
      const gradient = ctx.createLinearGradient(0, 0, 0, 512);
      gradient.addColorStop(0, '#04152d');   // Deep dark navy at North Pole
      gradient.addColorStop(0.3, '#0b355c'); // Mid blue
      gradient.addColorStop(0.5, '#175d96'); // Brighter aesthetic blue at Equator
      gradient.addColorStop(0.7, '#0b355c'); // Mid blue
      gradient.addColorStop(1, '#04152d');   // Deep dark navy at South Pole

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1024, 512);
    }
    const texture = new THREE.CanvasTexture(canvas);

    return new THREE.MeshPhongMaterial({
      map: texture,
      shininess: 12,
    });
  }, []);

  const graticules = useMemo(() => {
    const paths = [];

    // Latitudes (parallels) every 5 degrees
    for (let lat = -85; lat <= 85; lat += 5) {
      const coords = [];
      for (let lng = -180; lng <= 180; lng += 5) {
        coords.push([lat, lng]);
      }
      paths.push(coords);
    }

    // Longitudes (meridians) every 5 degrees
    for (let lng = -180; lng <= 175; lng += 5) {
      const coords = [];
      for (let lat = -90; lat <= 90; lat += 5) {
        coords.push([lat, lng]);
      }
      paths.push(coords);
    }

    return paths;
  }, []);

  const handleFocusBayOfBengal = () => {
    if (globeRef.current) {
      triggerFlight({ lat: 13.5, lng: 90, altitude: 0.45 }, 2000);
      setFocusedRegion('bob');
      focusedRegionRef.current = 'bob';
    }
  };

  const handleFocusArabianSea = () => {
    if (globeRef.current) {
      triggerFlight({ lat: 14.5, lng: 63.5, altitude: 0.45 }, 2000);
      setFocusedRegion('as');
      focusedRegionRef.current = 'as';
    }
  };

  const handleBackToOverview = () => {
    setFocusedRegion(null);
    focusedRegionRef.current = null;
    setClickedCell(null);
    setHoveredCell(null);
    setSearchedLocation(null);
    if (globeRef.current) {
      triggerFlight({ lat: 5, lng: 80, altitude: 0.8 }, 1500);
    }
  };

  // ── Coordinate Search Handler ──────────────────────────────────────────────
  const handleCoordinateSearch = useCallback((coords: { lat: number; lon: number }) => {
    const { lat, lon } = coords;

    // Determine which region the coordinate falls into
    const bob = REGION_BOUNDS['bob'];
    const as_ = REGION_BOUNDS['as'];
    let region: 'bob' | 'as' | null = null;

    if (lat >= bob.minLat && lat <= bob.maxLat && lon >= bob.minLng && lon <= bob.maxLng) {
      region = 'bob';
    } else if (lat >= as_.minLat && lat <= as_.maxLat && lon >= as_.minLng && lon <= as_.maxLng) {
      region = 'as';
    }

    if (!region) return;

    // Store the searched location for the pin
    setSearchedLocation({ lat, lon });

    // Focus the region
    setFocusedRegion(region);
    focusedRegionRef.current = region;

    // Fly the camera to the searched coordinate
    if (globeRef.current) {
      triggerFlight({ lat, lng: lon, altitude: 0.35 }, 2000);
    }

    // Compute the parent 5° grid cell and open the sidebar
    const gridLat = Math.floor(lat / 5) * 5;
    const gridLng = Math.floor(lon / 5) * 5;

    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    setClickedCell({
      minLat: gridLat,
      maxLat: gridLat + 5,
      minLng: gridLng,
      maxLng: gridLng + 5,
    });
    setIsClosing(false);
  }, []);



  const clickedCellPolygon = useMemo(() => {
    if (!clickedCell) return null;
    const { minLat, minLng } = clickedCell;
    const coords = [];
    const numSegments = 10;
    const step = 5 / numSegments;

    for (let i = 0; i < numSegments; i++) coords.push([minLng, minLat + i * step]);
    for (let i = 0; i < numSegments; i++) coords.push([minLng + i * step, minLat + 5]);
    for (let i = 0; i < numSegments; i++) coords.push([minLng + 5, minLat + 5 - i * step]);
    for (let i = 0; i < numSegments; i++) coords.push([minLng + 5 - i * step, minLat]);
    coords.push([minLng, minLat]);

    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coords] },
      properties: { isClicked: true, isFadingOut: isClosing }
    };
  }, [clickedCell, isClosing]);

  const allPolygons = useMemo(() => {
    const polys = [...landPolygons];
    if (clickedCellPolygon) polys.push(clickedCellPolygon as any);

    if (hoveredCell) {
      if (clickedCell) {
        const hCoords = hoveredCell.geometry.coordinates[0][0]; // [lng, lat]
        if (hCoords[0] === clickedCell.minLng && hCoords[1] === clickedCell.minLat) {
          // Do not push hoveredCell if it matches clickedCell to prevent yellow overriding red
        } else {
          polys.push(hoveredCell);
        }
      } else {
        polys.push(hoveredCell);
      }
    }
    return polys;
  }, [landPolygons, hoveredCell, clickedCellPolygon, clickedCell]);

  const htmlElements = useMemo(() => {
    return [
      ...labels,
      ...(searchedLocation ? [{ text: '', lat: searchedLocation.lat, lng: searchedLocation.lon, isPin: true }] : []),
    ];
  }, [labels, searchedLocation]);

  const getHtmlLat = useCallback((d: any) => d.lat, []);
  const getHtmlLng = useCallback((d: any) => d.lng, []);
  const getHtmlAltitude = useCallback((d: any) => d.isPin ? 0.02 : 0, []);
  const getHtmlElement = useCallback((d: any) => {
    if (d.isPin) {
      const pin = document.createElement('div');
      pin.className = 'globe-drop-pin';
      pin.innerHTML = '<div class="pin-head"></div><div class="pin-stem"></div>';
      return pin;
    }

    const container = document.createElement('div');
    const el = document.createElement('span');
    el.className = 'globe-label';
    el.innerHTML = d.text;
    el.style.color = d.isOcean ? 'rgba(255, 255, 255, 0.45)' : 'rgba(120, 120, 120, 0.6)';
    el.style.fontSize = d.isOcean ? '13px' : '10px';
    el.style.fontWeight = '300';
    el.style.fontFamily = 'Inter, sans-serif';
    el.style.letterSpacing = d.isOcean ? '1px' : '0.5px';
    el.style.textShadow = d.isOcean ? 'none' : '0px 0px 2px rgba(255,255,255,0.8)';
    el.style.whiteSpace = 'nowrap';

    container.style.pointerEvents = 'none';
    container.style.zIndex = '1';
    container.appendChild(el);
    return container;
  }, []);

  return (
    <div className={showLoading ? 'loading-active' : (!introFinished ? 'intro-active' : '')} style={{ position: 'relative', width: '100%', height: '100%', background: '#000' }}>
      <Globe
        ref={globeRef}
        width={windowSize.width}
        height={windowSize.height}
        backgroundColor="#000000"
        globeMaterial={globeMaterial}
        showAtmosphere={true}
        atmosphereColor="#00c8ff"
        atmosphereAltitude={0.1}
        pathsData={graticules}
        pathPoints={(d: any) => d}
        pathPointLat={(p: any) => p[0]}
        pathPointLng={(p: any) => p[1]}
        pathColor={() => 'rgba(200, 200, 200, 0.12)'}
        polygonsData={allPolygons}
        polygonsTransitionDuration={800}
        polygonAltitude={(d: any) => (d.properties?.isHovered || d.properties?.isClicked) ? 0.011 : 0.01}
        polygonCapColor={(d: any) =>
          d.properties?.isFadingOut ? 'rgba(255, 50, 50, 0)' :
            d.properties?.isClicked ? 'rgba(255, 50, 50, 0.25)' :
              d.properties?.isHovered ? 'rgba(255, 191, 0, 0.15)' : '#ffffff'
        }
        polygonSideColor={(d: any) => (d.properties?.isHovered || d.properties?.isClicked) ? 'rgba(0, 0, 0, 0)' : '#ffffff'}
        polygonStrokeColor={(d: any) =>
          d.properties?.isFadingOut ? 'rgba(255, 50, 50, 0)' :
            d.properties?.isClicked ? 'rgba(255, 50, 50, 1)' :
              d.properties?.isHovered ? 'rgba(255, 191, 0, 1)' : 'rgba(255, 120, 130, 0.45)'
        }
        htmlElementsData={htmlElements}
        htmlLat={getHtmlLat}
        htmlLng={getHtmlLng}
        htmlAltitude={getHtmlAltitude}
        htmlElement={getHtmlElement}
        onGlobeReady={() => {
          if (globeRef.current) {
            const renderer = globeRef.current.renderer();
            const camera = globeRef.current.camera();
            const scene = globeRef.current.scene();

            // --- Mouse hover raycasting for cursor pointer ---
            const raycaster = new THREE.Raycaster();
            const mouse = new THREE.Vector2();

            // Add custom crisp starfield
            if (!scene.userData.hasStars) {
              scene.userData.hasStars = true;
              const starsGeometry = new THREE.BufferGeometry();
              const starsMaterial = new THREE.PointsMaterial({
                color: 0xffffff,
                size: 1.0, // 1 pixel wide crisp stars
                sizeAttenuation: false, // Prevents them from getting huge/blotchy
                transparent: true,
                opacity: 0.6
              });

              const starsVertices = [];
              for (let i = 0; i < 4000; i++) {
                // Spread stars in a large sphere around the camera
                const r = 800 + Math.random() * 1200;
                const theta = 2 * Math.PI * Math.random();
                const phi = Math.acos(2 * Math.random() - 1);

                const x = r * Math.sin(phi) * Math.cos(theta);
                const y = r * Math.sin(phi) * Math.sin(theta);
                const z = r * Math.cos(phi);

                starsVertices.push(x, y, z);
              }

              starsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starsVertices, 3));
              const starField = new THREE.Points(starsGeometry, starsMaterial);
              scene.add(starField);
            }

            let lastHoveredGrid: string | null = null;
            let pointerDownPos = { x: 0, y: 0 };
            let cachedGlobeMesh: any = null;
            let cachedSphereMesh: any = null;
            const onMouseMove = (event: MouseEvent) => {
              if (isFlightAnimatingRef.current) {
                renderer.domElement.style.cursor = 'default';
                if (lastHoveredGrid !== null) {
                  lastHoveredGrid = null;
                  setHoveredCell(null);
                }
                return;
              }

              const rect = renderer.domElement.getBoundingClientRect();
              mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
              mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
              raycaster.setFromCamera(mouse, camera);

              if (!cachedGlobeMesh) {
                cachedGlobeMesh = scene.children.find((c: any) => c.type === 'Group') || null;
              }
              if (!cachedGlobeMesh) return;

              if (!cachedSphereMesh) {
                // OPTIMIZATION: Instead of intersecting every complex country polygon and path on the globe (O(N) cost),
                // we specifically target the cached base globe sphere for an O(1) perfect mathematical intersection.
                cachedSphereMesh = cachedGlobeMesh.children.find((c: any) => c.type === 'Mesh' && c.material === globeMaterial) || null;
              }

              const intersects = cachedSphereMesh
                ? raycaster.intersectObject(cachedSphereMesh)
                : raycaster.intersectObjects(cachedGlobeMesh.children, true);

              if (intersects.length > 0) {
                const point = intersects[0].point;
                // Convert 3D point to lat/lng (globe radius ~100)
                const r = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
                const lat = (Math.asin(point.y / r) * 180) / Math.PI;
                const lng = (Math.atan2(point.x, point.z) * 180) / Math.PI;

                const currentRegion = focusedRegionRef.current;

                if (!currentRegion) {
                  const bob = REGION_BOUNDS['bob'];
                  const as = REGION_BOUNDS['as'];
                  if ((lat >= bob.minLat && lat <= bob.maxLat && lng >= bob.minLng && lng <= bob.maxLng) ||
                    (lat >= as.minLat && lat <= as.maxLat && lng >= as.minLng && lng <= as.maxLng)) {
                    renderer.domElement.style.cursor = 'pointer';
                  } else {
                    renderer.domElement.style.cursor = 'default';
                  }
                  if (lastHoveredGrid !== null) {
                    lastHoveredGrid = null;
                    setHoveredCell(null);
                  }
                } else {
                  const bounds = REGION_BOUNDS[currentRegion];
                  if (lat >= bounds.minLat && lat <= bounds.maxLat &&
                    lng >= bounds.minLng && lng <= bounds.maxLng) {
                    renderer.domElement.style.cursor = 'pointer';

                    const minLat = Math.floor(lat / 5) * 5;
                    const minLng = Math.floor(lng / 5) * 5;
                    const gridKey = `${minLat}-${minLng}`;

                    if (lastHoveredGrid !== gridKey) {
                      lastHoveredGrid = gridKey;

                      const coords = [];
                      const numSegments = 10;
                      const step = 5 / numSegments;

                      // Left edge (up)
                      for (let i = 0; i < numSegments; i++) coords.push([minLng, minLat + i * step]);
                      // Top edge (right)
                      for (let i = 0; i < numSegments; i++) coords.push([minLng + i * step, minLat + 5]);
                      // Right edge (down)
                      for (let i = 0; i < numSegments; i++) coords.push([minLng + 5, minLat + 5 - i * step]);
                      // Bottom edge (left)
                      for (let i = 0; i < numSegments; i++) coords.push([minLng + 5 - i * step, minLat]);

                      coords.push([minLng, minLat]); // close loop

                      setHoveredCell({
                        type: 'Feature',
                        geometry: {
                          type: 'Polygon',
                          coordinates: [coords]
                        },
                        properties: { isHovered: true }
                      });
                    }
                  } else {
                    renderer.domElement.style.cursor = 'default';
                    if (lastHoveredGrid !== null) {
                      lastHoveredGrid = null;
                      setHoveredCell(null);
                    }
                  }
                }
              } else {
                renderer.domElement.style.cursor = 'default';
                if (lastHoveredGrid !== null) {
                  lastHoveredGrid = null;
                  setHoveredCell(null);
                }
              }
            };

            const onPointerDown = (e: PointerEvent) => {
              pointerDownPos = { x: e.clientX, y: e.clientY };
            };

            const onPointerUp = (e: PointerEvent) => {
              if (isFlightAnimatingRef.current) return;
              const dx = e.clientX - pointerDownPos.x;
              const dy = e.clientY - pointerDownPos.y;
              if (Math.sqrt(dx * dx + dy * dy) > 5) return; // It was a drag

              const currentRegion = focusedRegionRef.current;

              const rect = renderer.domElement.getBoundingClientRect();
              mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
              mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
              raycaster.setFromCamera(mouse, camera);

              if (!cachedGlobeMesh) {
                cachedGlobeMesh = scene.children.find((c: any) => c.type === 'Group') || null;
              }
              if (!cachedGlobeMesh) return;

              if (!cachedSphereMesh) {
                cachedSphereMesh = cachedGlobeMesh.children.find((c: any) => c.type === 'Mesh' && c.material === globeMaterial) || null;
              }

              const intersects = cachedSphereMesh
                ? raycaster.intersectObject(cachedSphereMesh)
                : raycaster.intersectObjects(cachedGlobeMesh.children, true);

              if (intersects.length > 0) {
                const point = intersects[0].point;
                const r = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
                const lat = (Math.asin(point.y / r) * 180) / Math.PI;
                const lng = (Math.atan2(point.x, point.z) * 180) / Math.PI;

                if (!currentRegion) {
                  const bob = REGION_BOUNDS['bob'];
                  const as = REGION_BOUNDS['as'];
                  if (lat >= bob.minLat && lat <= bob.maxLat && lng >= bob.minLng && lng <= bob.maxLng) {
                    handleFocusBayOfBengal();
                  } else if (lat >= as.minLat && lat <= as.maxLat && lng >= as.minLng && lng <= as.maxLng) {
                    handleFocusArabianSea();
                  }
                } else {
                  const bounds = REGION_BOUNDS[currentRegion];
                  if (lat >= bounds.minLat && lat <= bounds.maxLat &&
                    lng >= bounds.minLng && lng <= bounds.maxLng) {
                    const minLat = Math.floor(lat / 5) * 5;
                    const maxLat = minLat + 5;
                    const minLng = Math.floor(lng / 5) * 5;
                    const maxLng = minLng + 5;

                    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
                    setClickedCell({ minLat, maxLat, minLng, maxLng });
                    setIsClosing(false);
                    if (searchedLocationRef.current) {
                      if (currentRegion === 'bob') {
                        handleFocusBayOfBengal();
                      } else if (currentRegion === 'as') {
                        handleFocusArabianSea();
                      }
                    }
                    setSearchedLocation(null);
                  }
                }
              }
            };

            renderer.domElement.addEventListener('mousemove', onMouseMove);
            renderer.domElement.addEventListener('pointerdown', onPointerDown);
            renderer.domElement.addEventListener('pointerup', onPointerUp);
            cleanupMouseRef.current = () => {
              renderer.domElement.removeEventListener('mousemove', onMouseMove);
              renderer.domElement.removeEventListener('pointerdown', onPointerDown);
              renderer.domElement.removeEventListener('pointerup', onPointerUp);
            };

            // Add aesthetic bloom effect using post-processing
            // OPTIMIZATION: Only enable Bloom if the device has a decent CPU (>4 cores) to save performance on low-end
            if (navigator.hardwareConcurrency === undefined || navigator.hardwareConcurrency > 4) {
              const composer = globeRef.current.postProcessingComposer();
              const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.04, 0.2, 0.85);
              composer.addPass(bloomPass);
            }

            let isZooming = false;
            let zoomSnapTimeout: ReturnType<typeof setTimeout> | null = null;
            renderer.domElement.addEventListener('wheel', () => {
              isZooming = true;
              if (zoomSnapTimeout) clearTimeout(zoomSnapTimeout);
              zoomSnapTimeout = setTimeout(() => {
                isZooming = false;
                if (!globeRef.current || isIntroPlaying.current || focusedRegionRef.current) return;
                const pov = globeRef.current.pointOfView();
                // If zoomed out past altitude 0.8, snap it back instantly
                if (pov.altitude > 0.8) {
                  globeRef.current.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: 0.8 }, 400);
                }
              }, 50);
            });

            // Cinematic Entrance: Start zoomed out on the opposite side of the globe
            globeRef.current.pointOfView({ lat: 0, lng: -100, altitude: 3.5 }, 0);

            // Mark globe as ready, flight animation triggered by useEffect
            setIsGlobeReady(true);

            const controls = globeRef.current.controls();
            // Add resistance feel by making rotation slightly heavier
            controls.rotateSpeed = 0.4;
            controls.zoomSpeed = 1.0; // Set once; never touched in the rAF loop
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;

            // Free up the hard constraints to allow for our custom "catapult" physics
            controls.minPolarAngle = 0;
            controls.maxPolarAngle = Math.PI;
            controls.minAzimuthAngle = -Infinity;
            controls.maxAzimuthAngle = Infinity;

            const softMinAz = (75 * Math.PI) / 180;
            const softMaxAz = (85 * Math.PI) / 180;
            const softMinPol = (80 * Math.PI) / 180;
            const softMaxPol = (90 * Math.PI) / 180;

            let isDragging = false;

            controls.addEventListener('start', () => {
              isDragging = true;
              if (!reqIdRef.current) applyResistance();
            });

            // Event listener for snapping back (catapult effect) when they let go
            controls.addEventListener('end', () => {
              isDragging = false;
              // Prevent rotation snap from fighting with zoom wheel events (glitching)
              if (isZooming || !globeRef.current || isIntroPlaying.current || focusedRegionRef.current) return;

              const az = controls.getAzimuthalAngle();
              const pol = controls.getPolarAngle();
              const pov = globeRef.current.pointOfView();
              let needsSnap = false;

              let targetLat = pov.lat;
              let targetLng = pov.lng;
              let targetAlt = pov.altitude;

              // If rotation is out of bounds, snap rotation to center
              if (az < softMinAz || az > softMaxAz || pol < softMinPol || pol > softMaxPol) {
                targetLat = 5;
                targetLng = 80;
                needsSnap = true;
              }

              if (needsSnap) {
                globeRef.current.pointOfView({ lat: targetLat, lng: targetLng, altitude: targetAlt }, 800);
              }
            });

            // Physics loop for dynamic dragging resistance
            let lastRotOutAmount = 0;
            const applyResistance = () => {
              if (globeRef.current && !isIntroPlaying.current && !focusedRegionRef.current) {
                const az = controls.getAzimuthalAngle();
                const pol = controls.getPolarAngle();

                let rotOutAmount = 0;
                if (az < softMinAz) rotOutAmount = Math.max(rotOutAmount, softMinAz - az);
                if (az > softMaxAz) rotOutAmount = Math.max(rotOutAmount, az - softMaxAz);
                if (pol < softMinPol) rotOutAmount = Math.max(rotOutAmount, softMinPol - pol);
                if (pol > softMaxPol) rotOutAmount = Math.max(rotOutAmount, pol - softMaxPol);

                // Apply rotation resistance
                if (rotOutAmount > 0 && rotOutAmount >= lastRotOutAmount) {
                  controls.rotateSpeed = Math.max(0.01, 0.4 - (rotOutAmount * 1.5));
                } else {
                  controls.rotateSpeed = 0.4; // normal speed
                }

                lastRotOutAmount = rotOutAmount;

                // OPTIMIZATION: Only run the loop if dragging or snapping back
                if (isDragging || rotOutAmount > 0) {
                  reqIdRef.current = requestAnimationFrame(applyResistance);
                } else {
                  reqIdRef.current = null;
                }
              } else {
                reqIdRef.current = null;
              }
            };
          }
        }}
      />

      {/* Interactive elements */}
      {introFinished && (
        <motion.div
          className="glass-panel"
          onMouseEnter={() => setHoveredCell(null)}
          initial={{ opacity: 0, y: 20, x: '-50%', filter: 'blur(10px)' }}
          animate={{ opacity: 1, y: 0, x: '-50%', filter: 'blur(0px)' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
          style={{
            position: 'absolute',
            bottom: '32px',
            left: '50%',
            display: 'flex',
            gap: '16px',
            padding: '16px 24px',
            borderRadius: '24px',
            zIndex: 10
          }}
        >
          {focusedRegion ? (
            <button className="pill-button" onClick={handleBackToOverview}>
              ← Back to Overview
            </button>
          ) : (
            <>
              <button className="pill-button" onClick={handleFocusArabianSea}>
                Focus Arabian Sea
              </button>
              <button className="pill-button" onClick={handleFocusBayOfBengal}>
                Focus Bay of Bengal
              </button>
            </>
          )}
        </motion.div>
      )}

      {/* Grid cell popup — only shown when in focus and a cell is clicked */}
      {clickedCell && focusedRegion && (
        <>
          <div
            className={`sidebar-panel ${isClosing ? 'sidebar-panel-closing' : ''}`}
            onMouseEnter={() => setHoveredCell(null)}
            onAnimationEnd={() => {
              if (isClosing) {
                // Sidebar takes 400ms to close. Wait 400ms more for the 800ms fade to finish completely.
                closeTimeoutRef.current = setTimeout(() => {
                  setClickedCell(null);
                  setIsClosing(false);
                }, 400);
              }
            }}
          >
            {/* ── Sidebar Header ───────────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '500', letterSpacing: '0.5px' }}>
                {isLoading ? 'Fetching Profile…' :
                  fetchError?.type === 'network' ? 'Backend Unreachable' :
                    fetchError?.type === 'no-data' ? 'No Data Available' :
                      oceanData ? 'Ocean State Profile' : 'Ocean State Profile'}
              </h3>
              <button
                onClick={() => {
                  setIsClosing(true);
                  setIsModalOpen(false);
                  if (searchedLocation) {
                    if (focusedRegion === 'bob') {
                      handleFocusBayOfBengal();
                    } else if (focusedRegion === 'as') {
                      handleFocusArabianSea();
                    }
                  }
                  setSearchedLocation(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.5)',
                  cursor: 'pointer',
                  fontSize: '18px',
                  padding: '0 4px',
                }}
              >
                ✕
              </button>
            </div>

            {/* ── Sidebar Body ─────────────────────────────────────────────────── */}
            <div style={{ fontSize: '13px', fontWeight: '300', lineHeight: '1.8', color: 'rgba(255,255,255,0.65)', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Coordinate header */}
              {searchedLocation ? (
                <>
                  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Latitude:</span> {(Math.round(searchedLocation.lat / 0.25) * 0.25).toFixed(2)}°N</div>
                  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Longitude:</span> {(Math.round(searchedLocation.lon / 0.25) * 0.25).toFixed(2)}°E</div>
                </>
              ) : (
                <>
                  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Latitude:</span> {clickedCell.minLat}°N – {clickedCell.maxLat}°N</div>
                  <div><span style={{ color: 'rgba(255,255,255,0.4)' }}>Longitude:</span> {clickedCell.minLng}°E – {clickedCell.maxLng}°E</div>
                </>
              )}

              {/* ── Loading State ── */}
              {isLoading && (
                <div style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '16px',
                  padding: '24px',
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: '16px',
                  border: '1px solid rgba(139,182,214,0.1)',
                  backdropFilter: 'blur(8px)',
                }}>
                  {isPolling ? (
                    <div style={{ width: '100%', maxWidth: '240px', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                        <span style={{ fontSize: '12px', fontWeight: '500', color: '#8bb6d6', letterSpacing: '1px', textTransform: 'uppercase' }}>Processing</span>
                        <span style={{ fontSize: '12px', fontWeight: '600', color: '#fff' }}>{pollProgress}%</span>
                      </div>
                      <div style={{ width: '100%', height: '14px', background: 'rgba(0, 20, 40, 0.5)', borderRadius: '7px', overflow: 'hidden', border: '1px solid rgba(139,182,214,0.2)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.5)' }}>
                        <div style={{
                          width: `${pollProgress}%`,
                          height: '100%',
                          background: 'linear-gradient(90deg, #003366, #0074D9, #4facfe)',
                          transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          borderRadius: '6px',
                          position: 'relative',
                          overflow: 'hidden'
                        }}>
                          <div style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '40px',
                            height: '100%',
                            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)',
                            animation: 'travel-glare 1.5s infinite linear'
                          }} />
                        </div>
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>Generating Subsurface Matrix...</div>
                    </div>
                  ) : (
                    <>
                      <div style={{
                        width: '44px',
                        height: '44px',
                        borderRadius: '50%',
                        border: '2px solid rgba(139,182,214,0.15)',
                        borderTopColor: '#8bb6d6',
                        borderRightColor: 'rgba(139,182,214,0.5)',
                        animation: 'spin 0.9s linear infinite',
                        boxShadow: '0 0 20px rgba(139,182,214,0.2)',
                      }} />
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '12px', fontWeight: '500', color: '#8bb6d6', letterSpacing: '1.5px', textTransform: 'uppercase' }}>Fetching Ocean Data</div>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '4px' }}>Contacting AI inference server…</div>
                      </div>
                    </>
                  )}
                  <style>{`
                  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                  @keyframes travel-glare {
                    0% { transform: translateX(-50px) skewX(-20deg); }
                    100% { transform: translateX(260px) skewX(-20deg); }
                  }
                `}</style>
                </div>
              )}

              {/* ── Network Error State ── */}
              {!isLoading && fetchError?.type === 'network' && (
                <div style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '16px',
                  padding: '24px',
                  background: 'rgba(255,50,50,0.06)',
                  borderRadius: '16px',
                  border: '1px solid rgba(255,50,50,0.18)',
                }}>
                  <div style={{
                    width: '52px', height: '52px', borderRadius: '50%',
                    background: 'rgba(255,50,50,0.12)',
                    border: '1px solid rgba(255,80,80,0.25)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <WifiOff size={24} color="#ff7882" />
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '13px', fontWeight: '600', color: '#ff7882', letterSpacing: '0.5px' }}>Backend Unreachable</div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', marginTop: '6px', lineHeight: '1.6', maxWidth: '180px' }}>
                      {fetchError.message}
                    </div>
                  </div>
                  <button
                    id="retry-connection-btn"
                    onClick={() => triggerFetch(clickedCell.minLat, clickedCell.minLng, selectedDate)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '10px 20px',
                      background: 'rgba(255,80,80,0.12)',
                      border: '1px solid rgba(255,80,80,0.3)',
                      borderRadius: '10px',
                      color: '#ff7882',
                      fontSize: '12px',
                      fontWeight: '500',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      letterSpacing: '0.5px',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,80,80,0.22)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,80,80,0.12)'; e.currentTarget.style.transform = 'translateY(0)'; }}
                  >
                    <RefreshCw size={14} />
                    Retry Connection
                  </button>
                </div>
              )}

              {/* ── No Data State (404 / 422) ── */}
              {!isLoading && fetchError?.type === 'no-data' && (
                <div style={{
                  padding: '16px',
                  background: 'rgba(139,182,214,0.06)',
                  borderRadius: '12px',
                  border: '1px solid rgba(139,182,214,0.18)',
                }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', fontWeight: '500', color: '#8bb6d6', textTransform: 'uppercase', letterSpacing: '1px' }}>No Data Available</h4>
                  <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.55)', lineHeight: '1.6' }}>
                    {fetchError.message}
                  </p>
                </div>
              )}

              {/* ── Success State ── */}
              {!isLoading && !fetchError && oceanData && (
                <>
                  <div style={{ padding: '12px', background: 'rgba(255,255,255,0.06)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', fontWeight: '500', color: '#8bb6d6', textTransform: 'uppercase', letterSpacing: '1px' }}>Satellite Surface Inputs</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                      <button
                        onClick={() => setActiveObservation('SST')}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer', transition: 'all 0.2s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,120,130,0.15)'; e.currentTarget.style.borderColor = 'rgba(255,120,130,0.3)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><ThermometerSun size={16} color="#ff7882" /> SST</div>
                        <div style={{ fontWeight: 500 }}>{oceanData.surface_inputs.SST_celsius}°C</div>
                      </button>
                      <button
                        onClick={() => setActiveObservation('SSS')}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer', transition: 'all 0.2s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(53,183,121,0.15)'; e.currentTarget.style.borderColor = 'rgba(53,183,121,0.3)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Droplets size={16} color="#35b779" /> SSS</div>
                        <div style={{ fontWeight: 500 }}>{oceanData.surface_inputs.SSS_psu} psu</div>
                      </button>
                      <button
                        onClick={() => setActiveObservation('SSH')}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer', transition: 'all 0.2s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(139,182,214,0.15)'; e.currentTarget.style.borderColor = 'rgba(139,182,214,0.3)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Waves size={16} color="#8bb6d6" /> SSH</div>
                        <div style={{ fontWeight: 500 }}>{oceanData.surface_inputs.SSH_meters}m</div>
                      </button>
                      <button
                        onClick={() => setActiveObservation('Currents')}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer', transition: 'all 0.2s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(253,231,37,0.15)'; e.currentTarget.style.borderColor = 'rgba(253,231,37,0.3)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Navigation size={16} color="#fde725" /> Currents</div>
                        <div style={{ fontWeight: 500 }}>{oceanData.surface_inputs.currents_uv?.join(', ') ?? 'N/A'} m/s</div>
                      </button>
                      <button
                        onClick={() => setActiveObservation('Winds')}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', cursor: 'pointer', transition: 'all 0.2s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(212,165,165,0.15)'; e.currentTarget.style.borderColor = 'rgba(212,165,165,0.3)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Wind size={16} color="#d4a5a5" /> Winds</div>
                        <div style={{ fontWeight: 500 }}>{oceanData.surface_inputs.winds_uv?.join(', ') ?? 'N/A'} m/s</div>
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={() => setIsModalOpen(true)}
                    style={{
                      width: '100%',
                      padding: '12px',
                      background: 'linear-gradient(135deg, #175d96, #0b355c)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '13px',
                      fontWeight: '500',
                      cursor: 'pointer',
                      boxShadow: '0 4px 15px rgba(23, 93, 150, 0.4)',
                      transition: 'all 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-2px)';
                      e.currentTarget.style.boxShadow = '0 6px 20px rgba(23, 93, 150, 0.6)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = '0 4px 15px rgba(23, 93, 150, 0.4)';
                    }}
                  >
                    View 3D Subsurface Profile
                  </button>

                  <button
                    onClick={() => setIsValidationModalOpen(true)}
                    style={{
                      width: '100%',
                      padding: '12px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      color: '#ff7882',
                      border: '1px solid rgba(255, 120, 130, 0.3)',
                      borderRadius: '8px',
                      fontSize: '13px',
                      fontWeight: '500',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      marginTop: '4px'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 120, 130, 0.1)';
                      e.currentTarget.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                      e.currentTarget.style.transform = 'translateY(0)';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                      <Target size={16} />
                      View Validation Framework
                    </div>
                  </button>
                </>
              )}

              {/* ── Date Stepper (always shown at bottom) ── */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: 'auto', width: '100%', alignItems: 'flex-end' }}>
                {(() => {
                  const TODAY = new Date(2024, 11, 15);
                  return (
                    <>
                      <button
                        onClick={(e) => e.preventDefault()}
                        style={{
                          width: '36px', height: '36px', borderRadius: '50%', flexShrink: 0,
                          background: 'rgba(4, 21, 45, 0.7)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                          border: '1px solid rgba(139, 182, 214, 0.2)',
                          color: 'rgba(139, 182, 214, 0.8)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', transition: 'all 0.2s',
                          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.04)',
                          transform: 'scale(1)',
                          willChange: 'transform',
                          backfaceVisibility: 'hidden'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(139, 182, 214, 0.15)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.transform = 'scale(1.1)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(4, 21, 45, 0.7)'; e.currentTarget.style.color = 'rgba(139, 182, 214, 0.8)'; e.currentTarget.style.transform = 'scale(1)'; }}
                        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.95)'; }}
                        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
                        title="Go to Today (Dec 15, 2024)"
                      >
                        <Calendar size={16}>
                          <text x="12" y="18" fontSize="9" fontWeight="800" textAnchor="middle" fill="currentColor" stroke="none" textRendering="geometricPrecision">
                            {TODAY.getDate()}
                          </text>
                        </Calendar>
                      </button>
                      <DateStepper date={selectedDate} onChange={setSelectedDate} maxDate={TODAY} />
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </>
      )}

      <Suspense fallback={
        isModalOpen ? (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            zIndex: 100,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '50%', border: '3px solid rgba(139, 182, 214, 0.2)', borderTopColor: '#8bb6d6', animation: 'spin 1s linear infinite' }} />
              <span style={{ color: '#8bb6d6', fontSize: '13px', fontWeight: 500, letterSpacing: '1px' }}>LOADING SUBSURFACE ENGINE...</span>
              <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
            </div>
          </div>
        ) : null
      }>
        <DepthModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          predictions={oceanData?.ai_predictions}
          latRange={clickedCell ? [clickedCell.minLat, clickedCell.maxLat] : undefined}
          lngRange={clickedCell ? [clickedCell.minLng, clickedCell.maxLng] : undefined}
          searchedLocation={searchedLocation}
        />
        <ValidationModal
          isOpen={isValidationModalOpen}
          onClose={() => setIsValidationModalOpen(false)}
          data={oceanData ?? null}
          latRange={clickedCell ? [clickedCell.minLat, clickedCell.maxLat] : undefined}
          lngRange={clickedCell ? [clickedCell.minLng, clickedCell.maxLng] : undefined}
        />
        <ObservationModal
          isOpen={activeObservation !== null}
          onClose={() => setActiveObservation(null)}
          metricType={activeObservation}
          selectedDate={selectedDate}
          data={oceanData ?? null}
          latRange={clickedCell ? [clickedCell.minLat, clickedCell.maxLat] : undefined}
          lngRange={clickedCell ? [clickedCell.minLng, clickedCell.maxLng] : undefined}
        />
      </Suspense>

      {/* Coordinate Search Bar — hidden during loading/intro */}
      {introFinished && (
        <CoordinateSearch onSearch={handleCoordinateSearch} />
      )}

      <motion.div
        initial={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
        style={{
          position: 'absolute',
          top: '32px',
          left: '36px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          zIndex: 50,
          pointerEvents: 'none'
        }}
      >
        <img src={Logo} alt="OceanEmbed Logo" style={{ width: '40px', height: '40px' }} />
        <h2 style={{
          margin: 0,
          color: '#fff',
          fontFamily: "'Syne', sans-serif",
          fontSize: '24px',
          fontWeight: 600,
          letterSpacing: '-0.5px',
          textShadow: '0 2px 10px rgba(0,0,0,0.5)'
        }}>OceanEmbed</h2>
      </motion.div>

      {(showLoading || backendHealthy === false) && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 9999,
            backgroundColor: '#000',
            opacity: (fadeOutLoading && backendHealthy === true) ? 0 : 1,
            transition: 'opacity 0.8s ease-in-out',
            pointerEvents: backendHealthy === false ? 'auto' : 'none',
            backgroundImage: `url(${LoadingBg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingBottom: '60px',
          }}
        >
          {backendHealthy === false ? (
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'center' }}>
                <div style={{
                  width: '64px', height: '64px', borderRadius: '50%',
                  background: 'rgba(255,50,50,0.12)',
                  border: '1px solid rgba(255,80,80,0.25)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <WifiOff size={32} color="#ff7882" />
                </div>
              </div>
              <h1 style={{
                margin: 0,
                fontSize: '48px',
                fontWeight: 622,
                fontFamily: "'Syne', sans-serif",
                color: '#ff7882',
                letterSpacing: '-1.5px',
                textShadow: '0 4px 20px rgba(0,0,0,0.5)',
              }}>
                Backend Unreachable
              </h1>
              <p style={{
                margin: '8px 0 24px 0',
                fontSize: '15px',
                fontWeight: 400,
                fontFamily: "'Google Sans', 'Product Sans', sans-serif",
                color: 'rgba(255, 255, 255, 0.8)',
                letterSpacing: '-0.2px',
                textShadow: '0 2px 10px rgba(0,0,0,0.5)',
              }}>
                Could not connect to the AI inference server. Please check your connection and try again.
              </p>
              <button
                onClick={checkHealth}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '8px',
                  padding: '12px 24px',
                  background: 'rgba(255,80,80,0.12)',
                  border: '1px solid rgba(255,80,80,0.3)',
                  borderRadius: '12px',
                  color: '#ff7882',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  letterSpacing: '0.5px',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,80,80,0.22)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,80,80,0.12)'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                <RefreshCw size={16} />
                Retry Connection
              </button>
            </div>
          ) : (
            <>
              <h1 style={{
                margin: 0,
                fontSize: '56px',
                fontWeight: 622,
                fontFamily: "'Syne', sans-serif",
                color: '#fff',
                letterSpacing: '-1.5px',
                animation: 'strobe 2s ease-in-out infinite',
                textShadow: '0 4px 20px rgba(0,0,0,0.5)',
              }}>
                OceanEmbed
              </h1>
              <p style={{
                margin: '8px 0 0 0',
                fontSize: '15px',
                fontWeight: 400,
                fontFamily: "'Google Sans', 'Product Sans', sans-serif",
                color: 'rgba(255, 255, 255, 0.8)',
                letterSpacing: '-0.2px',
                textShadow: '0 2px 10px rgba(0,0,0,0.5)',
              }}>
                Satellite Embedding-Based Ocean Reconstruction
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default OceanGlobeView;

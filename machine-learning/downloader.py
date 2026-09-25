import os, glob, warnings, shutil
import numpy as np
import xarray as xr
import pandas as pd
import copernicusmarine
import earthaccess

warnings.filterwarnings("ignore")

ROOT = "/kaggle/working/ocean_data"
RAW_DIR = os.path.join(ROOT, "raw")
OUT_DIR = os.path.join(ROOT, "preprocessed_data")
os.makedirs(OUT_DIR, exist_ok=True)

LAT_MIN, LAT_MAX = 5.0, 30.0
LON_MIN, LON_MAX = 45.0, 105.0
RES = 0.25

TARGET_LAT = np.arange(LAT_MIN, LAT_MAX + RES/2, RES, dtype=np.float32)
TARGET_LON = np.arange(LON_MIN, LON_MAX + RES/2, RES, dtype=np.float32)
DEPTHS = np.array([0,5,10,20,30,50,75,100,125,150,200,300,500,700,1000], dtype=np.float32)

START_YEAR = 2021
END_YEAR = 2024 

def download_copernicus(dataset_id, start_date, end_date, out_name, variables=None, depth_max=None):
    kwargs = dict(
        dataset_id=dataset_id,
        start_datetime=f"{start_date} 00:00:00",
        end_datetime=f"{end_date} 23:59:59",
        minimum_longitude=LON_MIN, maximum_longitude=LON_MAX,
        minimum_latitude=LAT_MIN, maximum_latitude=LAT_MAX,
        output_directory=RAW_DIR,
        output_filename=out_name
    )
    if variables: kwargs["variables"] = variables
    if depth_max is not None: 
        kwargs["minimum_depth"] = 0
        kwargs["maximum_depth"] = depth_max
    
    copernicusmarine.subset(**kwargs)

def download_nasa(short_name, start_date, end_date):
    try:
        print(f"  -> Querying NASA Earthdata for {short_name}...")
        results = earthaccess.search_data(
            short_name=short_name,
            bounding_box=(LON_MIN, LAT_MIN, LON_MAX, LAT_MAX),
            temporal=(f"{start_date} 00:00:00", f"{end_date} 23:59:59")
        )
        if results:
            print(f"  -> Found {len(results)} granules. Downloading...")
            earthaccess.download(results, RAW_DIR)
            return True
        print(f"No granules found for {short_name}.")
        return False
    except Exception as e:
        print(f"NASA error for {short_name}: {e}")
        return False


def get_dates_safely(files):
    dates = set()
    for f in files:
        try:
            with xr.open_dataset(f) as ds:
                if "time" in ds.coords:
                    try:
                        dt_strings = ds.time.dt.strftime('%Y-%m-%d').values
                    except Exception:
                        dt_strings = np.array([str(t)[:10] for t in np.atleast_1d(ds.time.values)])
                    
                    if dt_strings.ndim == 0:
                        dt_strings = [str(dt_strings)]
                    dates.update(np.unique(dt_strings).tolist())
        except Exception:
            pass
    return dates


def process_layer(files, day_str, var_candidates, is_3d=False, k2c=False):

    for f in files:
        try:
            with xr.open_dataset(f) as ds:
                var = next((v for v in var_candidates if v in ds.data_vars), None)
                if not var or "time" not in ds.coords:
                    continue
                
                try:
                    time_strs = ds.time.dt.strftime('%Y-%m-%d').values
                except Exception:
                    time_strs = np.array([str(t)[:10] for t in np.atleast_1d(ds.time.values)])
                    
                if time_strs.ndim == 0:
                    time_strs = np.array([time_strs])
                    
                if day_str not in time_strs:
                    continue
                    
                if ds.time.ndim == 0:
                    da = ds[var]
                else:
                    mask = (time_strs == day_str)
                    da = ds.isel(time=mask)[var].mean(dim="time", keep_attrs=True)
                
                lat_dim = next((d for d in da.dims if 'lat' in str(d).lower() or str(d).lower() == 'y'), None)
                lon_dim = next((d for d in da.dims if 'lon' in str(d).lower() or str(d).lower() == 'x'), None)
                
                if not lat_dim or not lon_dim: 
                    continue
                
                lon_vals = np.asarray(da[lon_dim].values, dtype=np.float64)
                if np.nanmax(lon_vals) > 180:
                    lon_vals = ((lon_vals + 180) % 360) - 180
                    da = da.assign_coords({lon_dim: lon_vals})
                    
                _, index = np.unique(da[lon_dim].values, return_index=True)
                da = da.isel({lon_dim: index})
                da = da.sortby(lat_dim).sortby(lon_dim)
                
                allowed_dims = [lat_dim, lon_dim]
                depth_dim = None
                
                if is_3d:
                    depth_dim = next((d for d in da.dims if d.lower() in ["depth", "elevation", "z"]), None)
                    if depth_dim:
                        allowed_dims.append(depth_dim)
                        
                for d in list(da.dims):
                    if d not in allowed_dims:
                        da = da.isel({d: 0})
                        
                da = da.interp({lat_dim: TARGET_LAT, lon_dim: TARGET_LON}, method="linear")
                
                if is_3d and depth_dim:
                    da = da.interp({depth_dim: DEPTHS}, method="linear")
                    arr = np.asarray(da.transpose(depth_dim, lat_dim, lon_dim).values, dtype=np.float32)
                else:
                    arr = np.asarray(da.transpose(lat_dim, lon_dim).values, dtype=np.float32)
                    
                return arr - 273.15 if k2c else arr
        except Exception as e:
            print(f"    [Debug {day_str}] {var_candidates[0]} Extraction Error: {e}")
            pass
            
    return None


months_to_process = pd.date_range(start=f"{START_YEAR}-01-01", end=f"{END_YEAR}-11-01", freq='MS')

for m_start in months_to_process:
    m_end = m_start + pd.offsets.MonthEnd(1)
    start_str, end_str = m_start.strftime("%Y-%m-%d"), m_end.strftime("%Y-%m-%d")
    
    print(f"\n{'='*70}\nPROCESSING MONTH: {start_str} to {end_str}\n{'='*70}")
    
    if os.path.exists(RAW_DIR): shutil.rmtree(RAW_DIR)
    os.makedirs(RAW_DIR, exist_ok=True)
    
    # 1. DOWNLOAD PHASE
    print("Downloading Copernicus Data...")
    try:
        download_copernicus("cmems_mod_glo_phy_my_0.083deg_P1D-m", start_str, end_str, "glorys.nc", ["thetao"], depth_max=1000)
        download_copernicus("METOFFICE-GLO-SST-L4-REP-OBS-SST", start_str, end_str, "sst.nc", ["analysed_sst"])
        download_copernicus("cmems_obs-mob_glo_phy-sss_my_multi_P1D", start_str, end_str, "sss.nc", ["sos"])
        download_copernicus("cmems_obs-sl_glo_phy-ssh_my_allsat-l4-duacs-0.125deg_P1D", start_str, end_str, "ssh.nc", ["sla"])
    except Exception as e:
        print(f"Copernicus Download Error: {e}")

    print("Downloading NASA Data...")
    if not download_nasa("OSCAR_L4_OC_FINAL_V2.0", start_str, end_str):
        download_nasa("OSCAR_L4_OC_INTERIM_V2.0", start_str, end_str)
    download_nasa("CCMP_WINDS_10M6HR_L4_V3.1", start_str, end_str) 

    glorys_files = glob.glob(os.path.join(RAW_DIR, "glorys.nc"))
    sst_files = glob.glob(os.path.join(RAW_DIR, "sst.nc"))
    sss_files = glob.glob(os.path.join(RAW_DIR, "sss.nc"))
    ssh_files = glob.glob(os.path.join(RAW_DIR, "ssh.nc"))
    
    nasa_files = glob.glob(os.path.join(RAW_DIR, "**", "*.nc"), recursive=True)
    oscar_files = [f for f in nasa_files if "OSCAR" in f.upper()]
    ccmp_files = [f for f in nasa_files if "CCMP" in f.upper()]

    common_days = sorted(
        get_dates_safely(glorys_files) & get_dates_safely(sst_files) & get_dates_safely(sss_files) & 
        get_dates_safely(ssh_files) & get_dates_safely(oscar_files) & get_dates_safely(ccmp_files)
    )
    
    common_days = [d for d in common_days if start_str <= d <= end_str]
    print(f"Discovered {len(common_days)} days with complete channel overlap for {m_start.strftime('%B %Y')}.")


    for day in common_days:
        out_path = os.path.join(OUT_DIR, f"sample_{day}.npz")
        if os.path.exists(out_path): continue
            
        outputs = {
            "GLORYS": process_layer(glorys_files, day, ["thetao", "temp"], is_3d=True),
            "SST": process_layer(sst_files, day, ["analysed_sst", "sst"], k2c=True),
            "SSS": process_layer(sss_files, day, ["sos", "sss"]),
            "SSH": process_layer(ssh_files, day, ["sla", "ssh"]),
            "U_CUR": process_layer(oscar_files, day, ["u", "uo", "u_current", "u_surf", "U"]),
            "V_CUR": process_layer(oscar_files, day, ["v", "vo", "v_current", "v_surf", "V"]),
            "U_WIND": process_layer(ccmp_files, day, ["uwnd", "u10", "u", "U_wind"]),
            "V_WIND": process_layer(ccmp_files, day, ["vwnd", "v10", "v", "V_wind"])
        }


        missing = [k for k, v in outputs.items() if v is None]
        if missing:
            print(f"[{day}] ✗ Extractor skipped. Missing channels: {', '.join(missing)}")
            continue


        expected_shape = (len(TARGET_LAT), len(TARGET_LON))
        alignment_failed = False
        for name, arr in outputs.items():
            if name == "GLORYS": continue 
            if arr.shape != expected_shape:
                print(f"[{day}] ✗ Extractor skipped. {name} shape mismatch: {arr.shape} != {expected_shape}")
                alignment_failed = True
                break
                
        if alignment_failed: continue

        x = np.stack([
            outputs["SST"], outputs["SSS"], outputs["SSH"], 
            outputs["U_CUR"], outputs["V_CUR"], outputs["U_WIND"], outputs["V_WIND"]
        ], axis=0).astype(np.float32)
        
        y = outputs["GLORYS"]

        if np.isfinite(x).mean() < 0.25 or np.isfinite(y).mean() < 0.10: 
            print(f"[{day}] ✗ Extractor skipped: Too much land/NaN overlap.")
            continue

        np.savez_compressed(
            out_path,
            x=np.nan_to_num(x, nan=0.0).astype(np.float32),
            y=np.nan_to_num(y, nan=0.0).astype(np.float32),
            surface_mask=np.all(np.isfinite(x), axis=0).astype(np.float32),
            y_mask=np.isfinite(y).astype(np.float32)
        )
        print(f"[{day}] ✓ Saved successfully.")
    try: shutil.rmtree(RAW_DIR)
    except: pass
    print(f"Cleared raw data for {m_start.strftime('%B %Y')}. Disk space recovered!")

print("\nMULTI-YEAR PREPROCESSING COMPLETE")
print(f"Total `.npz` samples generated: {len(glob.glob(os.path.join(OUT_DIR, 'sample_*.npz')))}")
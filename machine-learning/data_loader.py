import os, glob
import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader, Subset
from datetime import datetime

class OceanDataset(Dataset):
    NATIVE_H, NATIVE_W = 101, 241
    PAD_H, PAD_W = 128, 256

    def __init__(self, data_dir, x_stats=None, y_stats=None):
        super().__init__()
        self.files = sorted(glob.glob(os.path.join(data_dir, "sample_*.npz")))
        if not self.files: raise FileNotFoundError(f"No preprocessed files in {data_dir}")

        with np.load(self.files[0]) as sample:
            self.n_in_ch = sample["x"].shape[0]
            self.n_out_ch = sample["y"].shape[0]

        self.x_mean, self.x_std = self._stats_or_identity(x_stats, self.n_in_ch)
        self.y_mean, self.y_std = self._stats_or_identity(y_stats, self.n_out_ch)
        
        lon_grid, lat_grid = np.meshgrid(
            np.linspace(-1, 1, self.NATIVE_W, dtype=np.float32),
            np.linspace(-1, 1, self.NATIVE_H, dtype=np.float32)
        )
        self.lat_t = torch.from_numpy(lat_grid).unsqueeze(0)
        self.lon_t = torch.from_numpy(lon_grid).unsqueeze(0)

    @staticmethod
    def _stats_or_identity(stats, n_ch):
        if stats is not None:
            mean = torch.as_tensor(stats["mean"], dtype=torch.float32).view(n_ch, 1, 1)
            std = torch.clamp(torch.as_tensor(stats["std"], dtype=torch.float32).view(n_ch, 1, 1), min=1e-7)
        else:
            mean, std = torch.zeros(n_ch, 1, 1, dtype=torch.float32), torch.ones(n_ch, 1, 1, dtype=torch.float32)
        return mean, std

    def __len__(self): return len(self.files)

    def __getitem__(self, idx):
        file_path = self.files[idx]
        with np.load(file_path) as data:
            x_t = torch.from_numpy(data["x"].astype(np.float32))
            y_t = torch.from_numpy(data["y"].astype(np.float32))
            surface_mask_t = torch.from_numpy(data["surface_mask"].astype(np.float32))
            depth_mask_t = torch.from_numpy(data["y_mask"].astype(np.float32))

        x_t = torch.where(surface_mask_t > 0.5, (x_t - self.x_mean) / self.x_std, 0.0)
        y_t = torch.where(depth_mask_t > 0.5, (y_t - self.y_mean) / self.y_std, 0.0)
        
        date_str = os.path.basename(file_path).replace("sample_", "").replace(".npz", "")
        doy = datetime.strptime(date_str, "%Y-%m-%d").timetuple().tm_yday
        sin_doy = torch.full((1, self.NATIVE_H, self.NATIVE_W), np.sin(2 * np.pi * doy / 365.25), dtype=torch.float32)
        cos_doy = torch.full((1, self.NATIVE_H, self.NATIVE_W), np.cos(2 * np.pi * doy / 365.25), dtype=torch.float32)

        x_enhanced = torch.cat([x_t, self.lat_t, self.lon_t, sin_doy, cos_doy], dim=0)

        x_padded = F.pad(x_enhanced, (0, self.PAD_W - self.NATIVE_W, 0, self.PAD_H - self.NATIVE_H), mode="constant", value=0.0)
        return x_padded, y_t, surface_mask_t, depth_mask_t


def compute_channel_stats(files, key, mask_key):
    files = sorted(files)
    with np.load(files[0]) as d: n_ch = d[key].shape[0]

    sums, sq_sums, counts = np.zeros(n_ch, dtype=np.float64), np.zeros(n_ch, dtype=np.float64), np.zeros(n_ch, dtype=np.float64)

    for fp in files:
        with np.load(fp) as d:
            arr, mask = d[key].astype(np.float64), d[mask_key].astype(np.float64)
            if mask.ndim == 2: mask = np.broadcast_to(mask, arr.shape)
            valid = np.isfinite(arr) & (mask > 0.5)
            a, m = np.where(valid, arr, 0.0).reshape(n_ch, -1), valid.reshape(n_ch, -1)
            sums += a.sum(axis=1)
            sq_sums += (a * a).sum(axis=1)
            counts += m.sum(axis=1)

    mean = sums / np.maximum(counts, 1.0)
    std = np.sqrt(np.maximum(sq_sums / np.maximum(counts, 1.0) - mean**2, 1e-8))
    return {"mean": mean.astype(np.float32), "std": std.astype(np.float32)}

print("DATASET MODULE READY")
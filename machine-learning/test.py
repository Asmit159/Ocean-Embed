class OceanEvalDataset(Dataset):
    NATIVE_H, NATIVE_W = 101, 241
    PAD_H, PAD_W = 128, 256

    def __init__(self, files: list, x_stats: dict, y_stats: dict):
        super().__init__()
        self.files = sorted(files)
        with np.load(self.files[0]) as sample:
            self.n_in_ch, self.n_out_ch = sample["x"].shape[0], sample["y"].shape[0]

        x_m = x_stats["mean"].numpy() if torch.is_tensor(x_stats["mean"]) else np.array(x_stats["mean"])
        x_s = x_stats["std"].numpy() if torch.is_tensor(x_stats["std"]) else np.array(x_stats["std"])
        y_m = y_stats["mean"].numpy() if torch.is_tensor(y_stats["mean"]) else np.array(y_stats["mean"])
        y_s = y_stats["std"].numpy() if torch.is_tensor(y_stats["std"]) else np.array(y_stats["std"])

        self.x_mean = torch.tensor(x_m, dtype=torch.float32).view(self.n_in_ch, 1, 1)
        self.x_std = torch.tensor(x_s, dtype=torch.float32).view(self.n_in_ch, 1, 1)
        self.y_mean = torch.tensor(y_m, dtype=torch.float32).view(self.n_out_ch, 1, 1)
        self.y_std = torch.tensor(y_s, dtype=torch.float32).view(self.n_out_ch, 1, 1)

        lon_grid, lat_grid = np.meshgrid(
            np.linspace(-1, 1, self.NATIVE_W, dtype=np.float32),
            np.linspace(-1, 1, self.NATIVE_H, dtype=np.float32)
        )
        self.lat_t = torch.from_numpy(lat_grid).unsqueeze(0)
        self.lon_t = torch.from_numpy(lon_grid).unsqueeze(0)

    def __len__(self) -> int: return len(self.files)

    def __getitem__(self, idx: int):
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
        
        month = int(date_str.split("-")[1])
        return x_padded, y_t, surface_mask_t, depth_mask_t, month



def extract_and_plot_training_history():
    json_paths = glob.glob("/kaggle/**/TRAINING_METRICS.json", recursive=True)
    pth_paths = glob.glob("/kaggle/**/oceanembed_last.pth", recursive=True)
    
    history, train_time, best_ep = None, "Unavailable", "Unavailable"
    
    if json_paths:
        try:
            with open(json_paths[0], 'r') as f: history = json.load(f)
        except Exception: pass
    elif pth_paths:
        try:
            ckpt = torch.load(pth_paths[0], map_location='cpu', weights_only=False)
            history = ckpt.get('history', None)
        except Exception: pass

    if history and "train_loss" in history:
        train_time = f"{history.get('total_runtime_hours', 0):.2f} Hours"
        best_ep = str(np.argmin(history.get('val_loss', [0])) + 1)
        
        epochs = np.arange(1, len(history['train_loss']) + 1)
        fig, axs = plt.subplots(2, 2, figsize=(15, 10))
        
        axs[0,0].plot(epochs, history['train_loss'], label='Train Loss')
        axs[0,0].plot(epochs, history['val_loss'], label='Val Loss')
        axs[0,0].set_title('Train vs Validation Loss'); axs[0,0].legend(); axs[0,0].grid(True)
        
        if 'val_mse' in history:
            axs[0,1].plot(epochs, np.sqrt(history['val_mse']), color='red')
            axs[0,1].set_title('Validation RMSE vs Epoch'); axs[0,1].grid(True)
            
        if 'val_mae' in history:
            axs[1,0].plot(epochs, history['val_mae'], color='orange')
            axs[1,0].set_title('Validation MAE vs Epoch'); axs[1,0].grid(True)
            
        axs[1,1].text(0.5, 0.5, "Learning Rate Log Not Found", ha='center', va='center', color='gray')
        axs[1,1].set_title('Learning Rate vs Epoch'); axs[1,1].set_xticks([]); axs[1,1].set_yticks([])
        
        plt.tight_layout()
        plt.savefig(os.path.join(REPORT_DIR, "01_training_history.png"), dpi=300)
        plt.close()
    return train_time, best_ep

def plot_depth_profiles(rmse, mae, bias, r2, year):
    fig, axs = plt.subplots(1, 4, figsize=(20, 6), sharey=True)
    metrics = [(rmse, 'RMSE vs Depth (°C)', 'r'), (mae, 'MAE vs Depth (°C)', 'm'), (bias, 'Bias vs Depth (°C)', 'g'), (r2, 'R² vs Depth', 'b')]
    for ax, (data, title, color) in zip(axs, metrics):
        ax.plot(data, DEPTHS, f'{color}-o', linewidth=2)
        if 'R²' in title: ax.set_xlim(0, 1.05)
        if 'Bias' in title: ax.axvline(x=0, color='k', linestyle='--')
        ax.set_title(title); ax.grid(True, linestyle='--')
    axs[0].set_ylim(1000, 0); axs[0].set_ylabel('Depth (meters)')
    plt.tight_layout()
    plt.savefig(os.path.join(REPORT_DIR, f"02_depth_profiles_{year}.png"), dpi=300)
    plt.close()

def plot_monthly_metrics(monthly_rmse, monthly_mae, year):
    months = np.arange(1, 13)
    fig, ax = plt.subplots(figsize=(10, 5))
    width = 0.35
    ax.bar(months - width/2, monthly_rmse, width, label='RMSE', color='indianred')
    ax.bar(months + width/2, monthly_mae, width, label='MAE', color='steelblue')
    ax.set_xticks(months); ax.set_xticklabels(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
    ax.set_title(f'Monthly {year} RMSE/MAE (°C)')
    ax.set_ylabel('Error (°C)'); ax.legend(); ax.grid(axis='y', linestyle='--')
    plt.savefig(os.path.join(REPORT_DIR, f"03_monthly_errors_{year}.png"), dpi=300)
    plt.close()

def plot_scatter_and_hist(preds, targets, year):
    fig, (ax1, ax2, ax3) = plt.subplots(1, 3, figsize=(18, 5))
    errors = preds - targets
    
    ax1.scatter(targets, preds, alpha=0.1, s=1, color='b')
    ax1.plot([targets.min(), targets.max()], [targets.min(), targets.max()], 'r--', lw=2)
    ax1.set_title('Predicted vs Actual Scatter'); ax1.set_xlabel('Observed (°C)'); ax1.set_ylabel('Predicted (°C)')
    
    ax2.hist(errors, bins=50, color='purple', edgecolor='black', alpha=0.7)
    ax2.axvline(x=0, color='r', linestyle='dashed', linewidth=2)
    ax2.set_title('Error Histogram'); ax2.set_xlabel('Error (°C)'); ax2.set_ylabel('Frequency')
    
    ax3.scatter(targets, errors, alpha=0.1, s=1, color='teal')
    ax3.axhline(y=0, color='r', linestyle='dashed', linewidth=2)
    ax3.set_title('Error vs Observed Temperature'); ax3.set_xlabel('Observed (°C)'); ax3.set_ylabel('Error (°C)')
    
    plt.tight_layout()
    plt.savefig(os.path.join(REPORT_DIR, f"04_scatter_and_error_{year}.png"), dpi=300)
    plt.close()

def plot_spatial_maps(gt, pred, mask, depth_idx, depth_label, year, prefix="05_single_day"):
    gt_map, pred_map = gt[depth_idx].copy(), pred[depth_idx].copy()
    gt_map[mask[depth_idx] == 0], pred_map[mask[depth_idx] == 0] = np.nan, np.nan
    err_map = np.abs(gt_map - pred_map)
    
    fig, axs = plt.subplots(1, 3, figsize=(18, 5))
    im0 = axs[0].imshow(gt_map, cmap='jet', origin='lower'); axs[0].set_title(f'Ground Truth ({depth_label}m)')
    im1 = axs[1].imshow(pred_map, cmap='jet', origin='lower'); axs[1].set_title(f'Prediction ({depth_label}m)')
    im2 = axs[2].imshow(err_map, cmap='inferno', origin='lower', vmin=0, vmax=1.5); axs[2].set_title(f'Absolute Error ({depth_label}m)')
    
    for ax, im in zip(axs, [im0, im1, im2]): fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    plt.tight_layout()
    plt.savefig(os.path.join(REPORT_DIR, f"{prefix}_spatial_maps_{year}_{depth_label}m.png"), dpi=300)
    plt.close()

def plot_global_spatial_rmse(spatial_sq_err, spatial_counts, depth_idx, depth_label, year):
    rmse_map = np.sqrt(spatial_sq_err[depth_idx] / (spatial_counts[depth_idx] + 1e-7))
    rmse_map[spatial_counts[depth_idx] == 0] = np.nan
    
    plt.figure(figsize=(10, 6))
    im = plt.imshow(rmse_map, cmap='inferno', origin='lower', vmin=0, vmax=1.5)
    plt.colorbar(im, label='RMSE (°C)')
    plt.title(f'{year} Aggregated Spatial RMSE Map ({depth_label}m Depth)')
    plt.tight_layout()
    plt.savefig(os.path.join(REPORT_DIR, f"06_global_spatial_rmse_{year}_{depth_label}m.png"), dpi=300)
    plt.close()

def plot_vertical_profile(gt_profile, pred_profile, mask_profile, year):
    valid_idx = np.where(mask_profile > 0)[0]
    if len(valid_idx) == 0: return
    
    plt.figure(figsize=(6, 8))
    plt.plot(gt_profile[valid_idx], DEPTHS[valid_idx], 'r-o', label='Ground Truth', linewidth=2)
    plt.plot(pred_profile[valid_idx], DEPTHS[valid_idx], 'b--o', label='Prediction', linewidth=2)
    plt.ylim(1000, 0); plt.title('Vertical Temperature Profile')
    plt.xlabel('Temperature (°C)'); plt.ylabel('Depth (meters)')
    plt.legend(); plt.grid(True, linestyle='--')
    plt.savefig(os.path.join(REPORT_DIR, f"07_vertical_profile_{year}.png"), dpi=300)
    plt.close()



def run_full_metrics_suite():
    print("\n" + "="*60)
    print(f"{YEAR_TO_TEST}")
    print("="*60)
    
    DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"⚡ Hardware Accelerator: {DEVICE.type.upper()}")
    
    process = psutil.Process(os.getpid())
    start_ram = process.memory_info().rss / (1024 * 1024)
    
    train_time, best_epoch = extract_and_plot_training_history()
    
    ckpt = torch.load(BEST_CKPT_PATH, map_location="cpu", weights_only=False)
    x_stats, y_stats = ckpt["x_stats"], ckpt["y_stats"]
    
    print("Loading native PyTorch architecture onto GPU...")
    infer_engine = OceanEmbed().to(DEVICE)
    infer_engine.load_state_dict(ckpt.get("model_state_dict", ckpt))
    infer_engine.eval()
    
    model_size_mb = os.path.getsize(BEST_CKPT_PATH) / (1024 * 1024)
    param_count = sum(p.numel() for p in infer_engine.parameters())
    
    test_files = sorted(glob.glob(os.path.join(OUT_DIR, f"sample_{YEAR_TO_TEST}-*.npz")))
    if not test_files: raise FileNotFoundError(f"No processed data found for {YEAR_TO_TEST}")
    
    test_loader = DataLoader(OceanEvalDataset(files=test_files, x_stats=x_stats, y_stats=y_stats), batch_size=1, shuffle=False)
    
    if DEVICE.type == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    
    d_sse, d_sae, d_sbe, d_var, d_cnt = np.zeros(15), np.zeros(15), np.zeros(15), np.zeros(15), np.zeros(15)
    m_sse, m_sae, m_sbe, m_cnt = np.zeros(13), np.zeros(13), np.zeros(13), np.zeros(13) 
    
    spatial_sq_err = np.zeros((15, 101, 241))
    spatial_counts = np.zeros((15, 101, 241))
    
    latencies, sampled_preds, sampled_targets = [], [], []
    
    y_s_val = y_stats["std"].numpy() if torch.is_tensor(y_stats["std"]) else np.array(y_stats["std"])
    y_m_val = y_stats["mean"].numpy() if torch.is_tensor(y_stats["mean"]) else np.array(y_stats["mean"])
    y_std = y_s_val.reshape(15, 1, 1)
    y_mean = y_m_val.reshape(15, 1, 1)
    
    captured_maps = False
    
    print(f"Streaming {len(test_files)} days through Native PyTorch Graph on {DEVICE.type.upper()}...")
    for inputs, targets, _, depth_masks, month in test_loader:
        inputs = inputs.to(DEVICE)
        
        if DEVICE.type == "cuda": torch.cuda.synchronize()
        t0 = time.perf_counter()
        
        with torch.no_grad(): 
            preds = infer_engine(inputs)
            
        if DEVICE.type == "cuda": torch.cuda.synchronize()
        latencies.append((time.perf_counter() - t0) * 1000)
        
        preds = preds.cpu().numpy()
        targets, depth_masks, m_idx = targets.numpy(), depth_masks.numpy(), month.item()
        
        p_c = (preds * y_std) + y_mean
        t_c = (targets * y_std) + y_mean
        err = (p_c - t_c) * depth_masks
        sq_err, abs_err = err ** 2, np.abs(err)
        
        daily_mean = t_c.sum(axis=(2, 3), keepdims=True) / (depth_masks.sum(axis=(2, 3), keepdims=True) + 1e-7)
        var = ((t_c - daily_mean) * depth_masks) ** 2
        
        spatial_sq_err += sq_err[0]
        spatial_counts += depth_masks[0]
        
        for d in range(15):
            d_sse[d] += sq_err[:, d, :, :].sum(); d_sae[d] += abs_err[:, d, :, :].sum()
            d_sbe[d] += err[:, d, :, :].sum(); d_var[d] += var[:, d, :, :].sum(); d_cnt[d] += depth_masks[:, d, :, :].sum()
            
        m_sse[m_idx] += sq_err.sum(); m_sae[m_idx] += abs_err.sum(); m_sbe[m_idx] += err.sum(); m_cnt[m_idx] += depth_masks.sum()
        
        valid_indices = np.where(depth_masks > 0.5)
        if len(valid_indices[0]) > 1000:
            choices = np.random.choice(len(valid_indices[0]), 1000, replace=False)
            sampled_preds.extend(p_c[valid_indices][choices]); sampled_targets.extend(t_c[valid_indices][choices])
            
        if m_idx == 7 and not captured_maps:
            plot_spatial_maps(t_c[0], p_c[0], depth_masks[0], 0, "0", YEAR_TO_TEST)
            plot_spatial_maps(t_c[0], p_c[0], depth_masks[0], 7, "100", YEAR_TO_TEST)
            plot_spatial_maps(t_c[0], p_c[0], depth_masks[0], 14, "1000", YEAR_TO_TEST)
            plot_vertical_profile(t_c[0, :, 50, 120], p_c[0, :, 50, 120], depth_masks[0, :, 50, 120], YEAR_TO_TEST)
            captured_maps = True

    rmse, mae, mbe = np.sqrt(d_sse / (d_cnt + 1e-7)), d_sae / (d_cnt + 1e-7), d_sbe / (d_cnt + 1e-7)
    r2 = 1 - (d_sse / (d_var + 1e-7))
    monthly_rmse, monthly_mae, monthly_bias = np.sqrt(m_sse[1:] / (m_cnt[1:] + 1e-7)), m_sae[1:] / (m_cnt[1:] + 1e-7), m_sbe[1:] / (m_cnt[1:] + 1e-7)
    
    s_preds, s_targets = np.array(sampled_preds), np.array(sampled_targets)
    pearson, _ = pearsonr(s_targets, s_preds)
    spearman, _ = spearmanr(s_targets, s_preds)
    
    mean_lat, throughput = np.mean(latencies), 1000 / np.mean(latencies)
    peak_mem = torch.cuda.max_memory_allocated() / (1024 * 1024) if DEVICE.type == "cuda" else (psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)) - start_ram
    mem_label = "Peak VRAM Overhead" if DEVICE.type == "cuda" else "Peak RAM Overhead"
    
    plot_depth_profiles(rmse, mae, mbe, r2, YEAR_TO_TEST)
    plot_monthly_metrics(monthly_rmse, monthly_mae, YEAR_TO_TEST)
    plot_scatter_and_hist(s_preds, s_targets, YEAR_TO_TEST)
    plot_global_spatial_rmse(spatial_sq_err, spatial_counts, 0, "0", YEAR_TO_TEST)
    plot_global_spatial_rmse(spatial_sq_err, spatial_counts, 7, "100", YEAR_TO_TEST)
    plot_global_spatial_rmse(spatial_sq_err, spatial_counts, 14, "1000", YEAR_TO_TEST)

    print("\n" + "="*60)
    print("1. MODEL & HARDWARE PROFILING")
    print("="*60)
    print(f"Format               : Native PyTorch (.pth)")
    print(f"Parameter Count      : {param_count:,}")
    print(f"Best Epoch           : {best_epoch}")
    print(f"Training Time        : {train_time}")
    print(f"Checkpoint File Size : {model_size_mb:.2f} MB")
    print(f"{mem_label:<20} : {max(0, peak_mem):.2f} MB during inference")
    print(f"Mean Inference Time  : {mean_lat:.2f} ms / sample ({DEVICE.type.upper()})")
    print(f"Max Throughput       : {throughput:.1f} inferences / second ({DEVICE.type.upper()})")

    print("\n" + "="*60)
    print("2. GLOBAL STATISTICAL METRICS")
    print("="*60)
    print(f"Overall RMSE         : {np.sqrt(d_sse.sum() / (d_cnt.sum() + 1e-7)):.4f} °C")
    print(f"Overall MAE          : {(d_sae.sum() / (d_cnt.sum() + 1e-7)):.4f} °C")
    print(f"Overall MSE          : {(d_sse.sum() / (d_cnt.sum() + 1e-7)):.4f} °C²")
    print(f"Overall Bias (MBE)   : {(d_sbe.sum() / (d_cnt.sum() + 1e-7)):.4f} °C")
    print(f"Overall R² Score     : {1 - (d_sse.sum() / (d_var.sum() + 1e-7)):.4f}")
    print(f"Pearson Correlation  : {pearson:.4f}")
    print(f"Spearman Correlation : {spearman:.4f}")

    print("\n" + "="*60)
    print(f"3. MONTHLY METRICS DEGRADATION ({YEAR_TO_TEST})")
    print("="*60)
    print(f"{'Month':<6} | {'RMSE (°C)':<10} | {'MAE (°C)':<10} | {'Bias (°C)':<10}")
    print("-" * 45)
    months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    for idx, m in enumerate(months): print(f"{m:<6} | {monthly_rmse[idx]:<10.3f} | {monthly_mae[idx]:<10.3f} | {monthly_bias[idx]:<10.3f}")

    print("\n" + "="*60)
    print("4. DEPTH-WISE PROFILING")
    print("="*60)
    print(f"{'Depth(m)':<10} | {'RMSE (°C)':<10} | {'MAE (°C)':<10} | {'Bias (°C)':<10} | {'R² Score':<10}")
    print("-" * 65)
    for d, r, m, b, rsq in zip(DEPTHS, rmse, mae, mbe, r2): print(f"{d:<10} | {r:<10.3f} | {m:<10.3f} | {b:<10.3f} | {rsq:<10.3f}")
    print("="*60)
    print(f"FULL METRICS EXTRACTED. All presentation graphs saved to: {REPORT_DIR}")

if __name__ == "__main__":
    run_full_metrics_suite()

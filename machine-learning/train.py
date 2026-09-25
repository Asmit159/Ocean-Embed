import os, glob, json, time
import numpy as np
import torch
import matplotlib.pyplot as plt
from torch.amp import GradScaler, autocast

DATA_DIR = "/kaggle/working/ocean_data/preprocessed_data"
OUTPUT_DIR = "/kaggle/working/checkpoints"
os.makedirs(OUTPUT_DIR, exist_ok=True)

BATCH_SIZE, ACCUMULATION_STEPS, EPOCHS, WARMUP_EPOCHS = 4, 4, 200, 10
LR, MIN_LR, WEIGHT_DECAY, GRAD_CLIP = 2e-4, 1e-6, 1e-2, 1.0
NUM_WORKERS = 2
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
AMP_ENABLED = DEVICE == "cuda"

BEST_CKPT = os.path.join(OUTPUT_DIR, "oceanembed_best.pth")
LAST_CKPT = os.path.join(OUTPUT_DIR, "oceanembed_last.pth")

def true_physical_metrics(pred, target, mask, y_mean_tensor, y_std_tensor):
    pred_phys, target_phys = pred * y_std_tensor + y_mean_tensor, target * y_std_tensor + y_mean_tensor
    valid = mask > 0.5
    
    if valid.sum() == 0: return 0.0, 0.0, 0
    diff = pred_phys[valid] - target_phys[valid]
    return (diff**2).sum().item(), torch.abs(diff).sum().item(), valid.sum().item()

def save_plots(history):
    epochs = np.arange(1, len(history["train_loss"]) + 1)
    plt.figure(figsize=(10,5))
    plt.plot(epochs, history["train_loss"], label="Train (Normalized)")
    plt.plot(epochs, history["val_loss"], label="Val (Normalized)")
    plt.legend(); plt.grid(True); plt.savefig(os.path.join(OUTPUT_DIR, "loss.png"), bbox_inches="tight"); plt.close()
    
    plt.figure(figsize=(10,5))
    plt.plot(epochs, np.sqrt(history["val_mse"]), label="Val Physical RMSE (°C)")
    plt.plot(epochs, history["val_mae"], label="Val Physical MAE (°C)")
    plt.legend(); plt.grid(True); plt.savefig(os.path.join(OUTPUT_DIR, "metrics.png"), bbox_inches="tight"); plt.close()

def train():
    print(f"Running Engine on: {DEVICE.upper()}")
    
    all_files = sorted(glob.glob(os.path.join(DATA_DIR, "sample_*.npz")))
    if not all_files: raise FileNotFoundError(f"No preprocessed data in {DATA_DIR}.")
    
    dates = [os.path.basename(f).replace("sample_","").replace(".npz","") for f in all_files]
    
    train_indices = [i for i, d in enumerate(dates) if int(d[:4]) < 2022]
    val_indices = [i for i, d in enumerate(dates) if d[:4] == "2022"]
    train_files = [all_files[i] for i in train_indices]
    
    print(f"\nCalculating channel normalization over {len(train_files)} training files...")
    x_stats = compute_channel_stats(train_files, "x", "surface_mask")
    y_stats = compute_channel_stats(train_files, "y", "y_mask")
    
    dataset = OceanDataset(DATA_DIR, x_stats, y_stats)
    
    train_loader = DataLoader(Subset(dataset, train_indices), batch_size=BATCH_SIZE, shuffle=True, num_workers=NUM_WORKERS, pin_memory=AMP_ENABLED, drop_last=True, persistent_workers=True)
    val_loader = DataLoader(Subset(dataset, val_indices), batch_size=BATCH_SIZE, shuffle=False, num_workers=NUM_WORKERS, pin_memory=AMP_ENABLED, persistent_workers=True)

    model = OceanEmbed().to(DEVICE)
    criterion = PhysicsInformedOceanLoss(y_stats).to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    
    def lr_lambda(e): return max(e, 1)/WARMUP_EPOCHS if e <= WARMUP_EPOCHS else MIN_LR/LR + (1 - MIN_LR/LR)*0.5*(1 + np.cos(np.pi*(e-WARMUP_EPOCHS)/max(EPOCHS-WARMUP_EPOCHS, 1)))
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)
    scaler = GradScaler("cuda", enabled=AMP_ENABLED)
    
    y_mean_t = torch.as_tensor(y_stats["mean"], dtype=torch.float32, device=DEVICE).view(1, -1, 1, 1)
    y_std_t = torch.as_tensor(y_stats["std"], dtype=torch.float32, device=DEVICE).view(1, -1, 1, 1)

    start_epoch = 1
    history = {"train_loss": [], "val_loss": [], "val_mse": [], "val_mae": []}
    best_val_loss = float("inf")
    
    if os.path.exists(LAST_CKPT):
        print(f"\n Found crash recovery checkpoint at {LAST_CKPT}.")
        checkpoint = torch.load(LAST_CKPT, map_location=DEVICE)
        model.load_state_dict(checkpoint['model_state_dict'])
        optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
        scheduler.load_state_dict(checkpoint['scheduler_state_dict'])
        scaler.load_state_dict(checkpoint['scaler_state_dict'])
        start_epoch = checkpoint['epoch'] + 1
        history = checkpoint['history']
        best_val_loss = checkpoint['best_val_loss']
        print(f" Resuming smoothly from Epoch {start_epoch} (Best Val Loss: {best_val_loss:.5f})")
    else:
        print("\n Starting training from scratch...")

    run_start = time.perf_counter()
    print(f"Commencing Training | Train={len(train_indices)} | Val={len(val_indices)}")
    
    for epoch in range(start_epoch, EPOCHS + 1):
        epoch_start = time.perf_counter()
        model.train()
        train_loss_sum, train_samples = 0.0, 0
        
        for step, (inputs, targets, _, depth_masks) in enumerate(train_loader):
            inputs, targets, depth_masks = inputs.to(DEVICE), targets.to(DEVICE), depth_masks.to(DEVICE)
            
            with autocast(device_type="cuda", dtype=torch.float16, enabled=AMP_ENABLED):
                loss = criterion(model(inputs), targets, depth_masks)
                
            scaler.scale(loss / ACCUMULATION_STEPS).backward()
            if (step + 1) % ACCUMULATION_STEPS == 0 or (step + 1) == len(train_loader):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), GRAD_CLIP)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                
            bs = inputs.size(0)
            train_loss_sum += loss.item() * bs
            train_samples += bs

        model.eval()
        val_loss_sum, val_sq_sum, val_ab_sum, val_n_valid, val_samples = 0.0, 0.0, 0.0, 0, 0
        
        with torch.no_grad():
            for inputs, targets, _, depth_masks in val_loader:
                inputs, targets, depth_masks = inputs.to(DEVICE), targets.to(DEVICE), depth_masks.to(DEVICE)
                
                with autocast(device_type="cuda", dtype=torch.float16, enabled=AMP_ENABLED):
                    preds = model(inputs)
                    loss = criterion(preds, targets, depth_masks)
                
                sq, ab, n = true_physical_metrics(preds, targets, depth_masks, y_mean_t, y_std_t)
                bs = inputs.size(0)
                val_loss_sum += loss.item() * bs
                val_samples += bs
                val_sq_sum += sq
                val_ab_sum += ab
                val_n_valid += n

        val_loss = val_loss_sum / max(val_samples, 1)
        val_mse = val_sq_sum / max(val_n_valid, 1)
        val_mae = val_ab_sum / max(val_n_valid, 1)
        
        scheduler.step()
        
        history["train_loss"].append(train_loss_sum / max(train_samples, 1))
        history["val_loss"].append(val_loss)
        history["val_mse"].append(val_mse)
        history["val_mae"].append(val_mae)
        
        print(f"Epoch [{epoch:03d}/{EPOCHS}] | "
              f"Train Loss: {history['train_loss'][-1]:.5f} | Val Loss: {val_loss:.5f} | "
              f"Physical RMSE: {np.sqrt(val_mse):.4f}°C | Physical MAE: {val_mae:.4f}°C | "
              f"Time: {(time.perf_counter()-epoch_start):.1f}s")
        
        torch.save({
            'epoch': epoch,
            'model_state_dict': model.state_dict(),
            'optimizer_state_dict': optimizer.state_dict(),
            'scheduler_state_dict': scheduler.state_dict(),
            'scaler_state_dict': scaler.state_dict(),
            'history': history,
            'best_val_loss': best_val_loss,
            'x_stats': x_stats,
            'y_stats': y_stats
        }, LAST_CKPT)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({"model_state_dict": model.state_dict(), "x_stats": x_stats, "y_stats": y_stats}, BEST_CKPT)
            
    print("\n Training Complete. Generating Reports...")
    
    history["total_runtime_hours"] = (time.perf_counter() - run_start) / 3600
    if torch.cuda.is_available():
        history["peak_vram_gb"] = torch.cuda.max_memory_allocated() / (1024 ** 3)
        
    save_plots(history)
    with open(os.path.join(OUTPUT_DIR, "TRAINING_METRICS.json"), "w") as f: json.dump(history, f, indent=2)

if __name__ == "__main__":
    train()
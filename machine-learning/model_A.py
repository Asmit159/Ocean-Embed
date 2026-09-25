import torch
import torch.nn as nn
import torch.nn.functional as F
import timm

class SpectralConv2d(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, modes1: int, modes2: int):
        super().__init__()
        self.in_channels, self.out_channels, self.modes1, self.modes2 = in_channels, out_channels, modes1, modes2
        scale = 1.0 / (in_channels * out_channels)
        self.weights1 = nn.Parameter(scale * torch.rand(in_channels, out_channels, modes1, modes2, 2, dtype=torch.float32))
        self.weights2 = nn.Parameter(scale * torch.rand(in_channels, out_channels, modes1, modes2, 2, dtype=torch.float32))

    def compl_mul2d(self, input_real, input_imag, weight_real, weight_imag):
        out_real = torch.einsum("bixy,ioxy->boxy", input_real, weight_real) - torch.einsum("bixy,ioxy->boxy", input_imag, weight_imag)
        out_imag = torch.einsum("bixy,ioxy->boxy", input_real, weight_imag) + torch.einsum("bixy,ioxy->boxy", input_imag, weight_real)
        return out_real, out_imag

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        orig_dtype = x.dtype
        x = x.to(torch.float32)
        B, C, H, W = x.shape
        
        x_ft = torch.fft.rfft2(x)
        x_ft_real = x_ft.real
        x_ft_imag = x_ft.imag
        
        out_real = torch.zeros(B, self.out_channels, H, x_ft.size(-1), device=x.device, dtype=torch.float32)
        out_imag = torch.zeros(B, self.out_channels, H, x_ft.size(-1), device=x.device, dtype=torch.float32)
        
        o1_real, o1_imag = self.compl_mul2d(
            x_ft_real[:, :, :self.modes1, :self.modes2], x_ft_imag[:, :, :self.modes1, :self.modes2],
            self.weights1[..., 0], self.weights1[..., 1]
        )
        
        o2_real, o2_imag = self.compl_mul2d(
            x_ft_real[:, :, -self.modes1:, :self.modes2], x_ft_imag[:, :, -self.modes1:, :self.modes2],
            self.weights2[..., 0], self.weights2[..., 1]
        )
        
        out_real = torch.cat([
            torch.cat([o1_real, out_real[:, :, self.modes1:-self.modes1, :self.modes2], o2_real], dim=2),
            out_real[:, :, :, self.modes2:]
        ], dim=3)
        
        out_imag = torch.cat([
            torch.cat([o1_imag, out_imag[:, :, self.modes1:-self.modes1, :self.modes2], o2_imag], dim=2),
            out_imag[:, :, :, self.modes2:]
        ], dim=3)
        
        out_ft = torch.complex(out_real, out_imag)
        out = torch.fft.irfft2(out_ft, s=(H, W))
        return out.to(orig_dtype)

class FNOBottleneck(nn.Module):
    def __init__(self, channels=256, modes1=8, modes2=16):
        super().__init__()
        self.spectral_conv = SpectralConv2d(channels, channels, modes1, modes2)
        self.w = nn.Conv2d(channels, channels, kernel_size=1)
    def forward(self, x): return F.gelu(self.spectral_conv(x) + self.w(x))

class DecoderBlock(nn.Module):
    def __init__(self, in_channels, skip_channels, out_channels):
        super().__init__()
        self.channel_reduce = nn.Sequential(nn.Conv2d(in_channels, skip_channels, 1, bias=False), nn.GELU())
        self.conv_block = nn.Sequential(
            nn.Conv2d(skip_channels * 2, out_channels, 3, padding=1, bias=False), nn.GELU(),
            nn.Conv2d(out_channels, out_channels, 3, padding=1, bias=False), nn.GELU()
        )
    def forward(self, x, skip):
        x = self.channel_reduce(F.interpolate(x, scale_factor=2.0, mode='bilinear', align_corners=False))
        return self.conv_block(torch.cat([x, skip], dim=1))

class LatentGraphReasoning(nn.Module):
    def __init__(self, in_channels=256, hidden_dim=128, k_neighbors=8):
        super().__init__()
        self.k, self.hidden_dim = k_neighbors, hidden_dim
        self.theta, self.phi, self.val = nn.Conv2d(in_channels, hidden_dim, 1), nn.Conv2d(in_channels, hidden_dim, 1), nn.Conv2d(in_channels, hidden_dim, 1)
        self.gcn_conv = nn.Sequential(nn.Linear(hidden_dim, hidden_dim, bias=False), nn.LayerNorm(hidden_dim), nn.GELU(), nn.Linear(hidden_dim, in_channels, bias=False))
        self.gamma = nn.Parameter(torch.zeros(1))

    def forward(self, x):
        B, C, H, W = x.shape
        theta_x, phi_x, val_x = self.theta(x).view(B, self.hidden_dim, -1).permute(0, 2, 1), self.phi(x).view(B, self.hidden_dim, -1), self.val(x).view(B, self.hidden_dim, -1).permute(0, 2, 1)
        adj = torch.bmm(theta_x, phi_x) * (self.hidden_dim ** -0.5)
        topk_vals, topk_indices = torch.topk(adj, k=self.k, dim=-1)

        sparse_adj = torch.full_like(adj, fill_value=-1e4).scatter(-1, topk_indices, topk_vals)
        graph_out = self.gcn_conv(torch.bmm(F.softmax(sparse_adj, dim=-1), val_x)).permute(0, 2, 1).view(B, C, H, W)
        return x + (self.gamma * graph_out)

class OceanEmbed(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(11, 64, 3, 1, 1), nn.GELU(), nn.Conv2d(64, 64, 3, 1, 1), nn.GELU(), nn.Conv2d(64, 96, 1, 1, 0))
        
        swin = timm.create_model('swinv2_tiny_window8_256', pretrained=True) 
        
        self.stage1, self.stage2, self.stage3, self.stage4 = swin.layers[0], swin.layers[1], swin.layers[2], swin.layers[3]
        self.latent_proj_in, self.latent_proj_out = nn.Conv2d(768, 256, 1), nn.Conv2d(256, 768, 1)
        self.fno = nn.Sequential(FNOBottleneck(256, 8, 16), FNOBottleneck(256, 8, 16), FNOBottleneck(256, 8, 16))
        self.gnn = LatentGraphReasoning(256, 128, 8)
        self.dec_stage3, self.dec_stage2, self.dec_stage1 = DecoderBlock(768, 384, 384), DecoderBlock(384, 192, 192), DecoderBlock(192, 96, 96)
        self.head = nn.Conv2d(96, 15, 1)

    def forward(self, x):
        x = self.stem(x).permute(0, 2, 3, 1)
        for b in self.stage1.blocks: x = b(x)
        skip1 = x.permute(0, 3, 1, 2)
        x = self.stage2.downsample(x)
        for b in self.stage2.blocks: x = b(x)
        skip2 = x.permute(0, 3, 1, 2)
        x = self.stage3.downsample(x)
        for b in self.stage3.blocks: x = b(x)
        skip3 = x.permute(0, 3, 1, 2)
        x = self.stage4.downsample(x)
        for b in self.stage4.blocks: x = b(x)
        
        latent = self.latent_proj_out(self.gnn(self.fno(self.latent_proj_in(x.permute(0, 3, 1, 2)))))
        return self.head(self.dec_stage1(self.dec_stage2(self.dec_stage3(latent, skip3), skip2), skip1))[:, :, :101, :241]
        
class PhysicsInformedOceanLoss(nn.Module):
    def __init__(self, y_stats, lambda_grad=0.1, lambda_strat=0.05):
        super().__init__()
        self.lambda_grad, self.lambda_strat = lambda_grad, lambda_strat
        self.register_buffer("y_mean", torch.as_tensor(y_stats["mean"], dtype=torch.float32).view(1, -1, 1, 1))
        self.register_buffer("y_std", torch.as_tensor(y_stats["std"], dtype=torch.float32).view(1, -1, 1, 1))

    def forward(self, pred, target, depth_mask):
        mask = depth_mask.float()
        valid = mask.sum() + 1e-7
        
        diff = (pred - target) * mask
        loss_mse = torch.sum(torch.where(torch.abs(diff) < 1.0, 0.5 * diff**2, torch.abs(diff) - 0.5)) / valid

        p_phys, t_phys = pred * self.y_std + self.y_mean, target * self.y_std + self.y_mean
        
        mask_dx, mask_dy = mask[:, :, :, 1:] * mask[:, :, :, :-1], mask[:, :, 1:, :] * mask[:, :, :-1, :]
        loss_grad_x = torch.sum((((p_phys[:, :, :, 1:] - p_phys[:, :, :, :-1]) - (t_phys[:, :, :, 1:] - t_phys[:, :, :, :-1])) * mask_dx) ** 2) / (mask_dx.sum() + 1e-7)
        loss_grad_y = torch.sum((((p_phys[:, :, 1:, :] - p_phys[:, :, :-1, :]) - (t_phys[:, :, 1:, :] - t_phys[:, :, :-1, :])) * mask_dy) ** 2) / (mask_dy.sum() + 1e-7)

        mask_strat = mask[:, 1:, :, :] * mask[:, :-1, :, :]
        loss_strat = torch.sum((torch.relu(p_phys[:, 1:, :, :] - p_phys[:, :-1, :, :]) * mask_strat) ** 2) / (mask_strat.sum() + 1e-7)

        return loss_mse + (self.lambda_grad * (loss_grad_x + loss_grad_y)) + (self.lambda_strat * loss_strat)

print("MODEL AND LOSS READY")

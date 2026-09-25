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

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        orig_dtype = x.dtype
        with torch.autocast(device_type=str(x.device.type), enabled=False):
            x = x.to(torch.float32)
            B, C, H, W = x.shape
            x_ft = torch.fft.rfft2(x)
            out_ft = torch.zeros(B, self.out_channels, H, x_ft.size(-1), dtype=torch.cfloat, device=x.device)
            w1, w2 = torch.view_as_complex(self.weights1), torch.view_as_complex(self.weights2)
            out_ft[:, :, :self.modes1, :self.modes2] = torch.einsum("bixy,ioxy->boxy", x_ft[:, :, :self.modes1, :self.modes2], w1)
            out_ft[:, :, -self.modes1:, :self.modes2] = torch.einsum("bixy,ioxy->boxy", x_ft[:, :, -self.modes1:, :self.modes2], w2)
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

class ChannelAttention(nn.Module):
    def __init__(self, in_planes, ratio=16):
        super(ChannelAttention, self).__init__()
        self.avg_pool = nn.AdaptiveAvgPool2d(1)
        self.max_pool = nn.AdaptiveMaxPool2d(1)
        self.fc1 = nn.Conv2d(in_planes, in_planes // ratio, 1, bias=False)
        self.relu1 = nn.ReLU()
        self.fc2 = nn.Conv2d(in_planes // ratio, in_planes, 1, bias=False)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x):
        avg_out = self.fc2(self.relu1(self.fc1(self.avg_pool(x))))
        max_out = self.fc2(self.relu1(self.fc1(self.max_pool(x))))
        return self.sigmoid(avg_out + max_out)

class SpatialAttention(nn.Module):
    def __init__(self, kernel_size=7):
        super(SpatialAttention, self).__init__()
        self.conv1 = nn.Conv2d(2, 1, kernel_size, padding=kernel_size//2, bias=False)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x):
        avg_out = torch.mean(x, dim=1, keepdim=True)
        max_out, _ = torch.max(x, dim=1, keepdim=True)
        x_cat = torch.cat([avg_out, max_out], dim=1)
        return self.sigmoid(self.conv1(x_cat))

class CBAM(nn.Module):
    def __init__(self, in_planes, ratio=16, kernel_size=7):
        super(CBAM, self).__init__()
        self.ca = ChannelAttention(in_planes, ratio)
        self.sa = SpatialAttention(kernel_size)

    def forward(self, x):
        x = x * self.ca(x)
        x = x * self.sa(x)
        return x

class LatentTemporalModule(nn.Module):
    def __init__(self, in_channels, num_heads=4):
        super().__init__()
        self.temporal_attention = nn.MultiheadAttention(embed_dim=in_channels, num_heads=num_heads, batch_first=False)
        self.norm = nn.LayerNorm(in_channels)
        
    def forward(self, x):
        B, C, H, W = x.shape
        
        x_reshaped = x.view(B, C, -1).permute(2, 0, 1) 
        
        attn_out, _ = self.temporal_attention(x_reshaped, x_reshaped, x_reshaped)
        
        attn_out = self.norm(x_reshaped + attn_out)
        
        out = attn_out.permute(1, 2, 0).view(B, C, H, W)
        return out

class OceanEmbed(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(11, 64, 3, 1, 1), nn.GELU(), nn.Conv2d(64, 64, 3, 1, 1), nn.GELU(), nn.Conv2d(64, 96, 1, 1, 0))
        
        swin = timm.create_model('swinv2_tiny_window8_256', pretrained=True) 
        self.stage1, self.stage2, self.stage3, self.stage4 = swin.layers[0], swin.layers[1], swin.layers[2], swin.layers[3]
        
        self.latent_proj_in, self.latent_proj_out = nn.Conv2d(768, 256, 1), nn.Conv2d(256, 768, 1)
        
        self.fno = nn.Sequential(FNOBottleneck(256, 8, 16), FNOBottleneck(256, 8, 16), FNOBottleneck(256, 8, 16))
        self.cbam = CBAM(in_planes=256)
        self.temporal = LatentTemporalModule(in_channels=256)
        
        self.dec_stage3, self.dec_stage2, self.dec_stage1 = DecoderBlock(768, 384, 384), DecoderBlock(384, 192, 192), DecoderBlock(192, 96, 96)
        self.head = nn.Conv2d(96, 15, 1)

    def forward(self, x):
        x = self.stem(x).permute(0, 2, 3, 1)
        
        if getattr(self.stage1, 'downsample', None) is not None: x = self.stage1.downsample(x)
        for b in self.stage1.blocks: x = b(x)
        skip1 = x.permute(0, 3, 1, 2) 
        
        if getattr(self.stage2, 'downsample', None) is not None: x = self.stage2.downsample(x)
        for b in self.stage2.blocks: x = b(x)
        skip2 = x.permute(0, 3, 1, 2) 
        
        if getattr(self.stage3, 'downsample', None) is not None: x = self.stage3.downsample(x)
        for b in self.stage3.blocks: x = b(x)
        skip3 = x.permute(0, 3, 1, 2) 
        
        if getattr(self.stage4, 'downsample', None) is not None: x = self.stage4.downsample(x)
        for b in self.stage4.blocks: x = b(x)
        
        fno_out = self.fno(self.latent_proj_in(x.permute(0, 3, 1, 2)))
        cbam_out = self.cbam(fno_out)
        temp_out = self.temporal(cbam_out)
        latent = self.latent_proj_out(temp_out)
        
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
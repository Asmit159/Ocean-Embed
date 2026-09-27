import torch
import torch.nn.functional as F
import numpy as np
device = 'cpu'
model_path = './models/oceanembed_sih_prototype.pt'
print('Loading model...')
model = torch.jit.load(model_path, map_location=device)
model.eval()
print('Model loaded.')

dummy_input = torch.zeros(1, 11, 128, 256, device=device, dtype=torch.float32)
# Adding some non-zero values to mimic real data
dummy_input[0, 0] = 20.0
dummy_input[0, 1] = 35.0
dummy_input[0, 7] = 0.5
dummy_input[0, 8] = 0.5

with torch.inference_mode():
    out = model(dummy_input)

print('Output shape:', out.shape)
print('Max:', out.max().item())
print('Min:', out.min().item())
print('Mean:', out.mean().item())
print('Standard deviation:', out.std().item())

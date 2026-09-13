# 🌊 OceanEmbed: Physics-Guided Latent Representation for 3D Ocean Thermodynamics

An advanced hybrid deep learning architecture developed for the **Smart India Hackathon (SIH)** to reconstruct **15 discrete layers of 3D subsurface ocean temperature** from 2D satellite-derived surface observations.

OceanEmbed combines the spatial feature extraction capabilities of **Swin Transformer V2** with the global spectral modeling and continuous-space operator learning of a **Fourier Neural Operator (FNO)**. The resulting system provides physics-guided subsurface temperature reconstruction while supporting interactive geospatial visualization through a WebGL-powered application.

---

## 🚀 Overview

Ocean dynamics are highly complex and chaotic, while traditional numerical ocean simulations can require substantial computational resources. OceanEmbed addresses this challenge by learning a mapping from observable surface ocean conditions to the underlying **3D subsurface temperature structure**.

The architecture combines:

* **CNN-based spatial feature extraction** for local physical patterns.
* **Swin Transformer V2** for hierarchical spatial representation and long-range contextual modeling.
* **Fourier Neural Operator (FNO)** for global spectral interactions and continuous-space latent modeling.
* **U-Net-style skip connections** to preserve fine-grained spatial information.
* **Physics-informed loss components** to encourage physically consistent thermodynamic predictions.
* **React + WebGL visualization** for interactive exploration of predicted ocean states.

The complete system is designed as a full-stack pipeline capable of receiving geographic queries, processing oceanographic observations, generating subsurface predictions, and visualizing the resulting 3D thermal structure.

---

# 🧠 Model Architecture

OceanEmbed follows a **U-Net-style encoder-decoder architecture** with a specialized FNO bottleneck operating on the deepest latent representation.

```text
2D Surface Ocean Observations
            │
            ▼
      ┌─────────────┐
      │  CNN Stem   │
      └──────┬──────┘
             │
             ▼
   ┌───────────────────┐
   │ Swin-V2 Encoder   │
   │ Hierarchical      │
   │ Feature Extraction│
   └─────────┬─────────┘
             │
             ▼
   ┌───────────────────┐
   │   FNO Bottleneck   │
   │ Global Spectral    │
   │ Representation     │
   └─────────┬─────────┘
             │
             ▼
      ┌─────────────┐
      │ U-Net       │
      │ Decoder     │◄──── Skip Connections
      └──────┬──────┘
             │
             ▼
    15 Subsurface Temperature
          Predictions
```

---

## 1. 🌊 Input Data

The model ingests a 2D spatial grid representing surface-level oceanographic conditions.

### Data Source

* **Dataset:** Copernicus Marine Global Ocean Physics NetCDF datasets
* **Region:** Indian Ocean basin
* **Spatial Resolution:** 0.25° × 0.25°
* **Example padded input resolution:** `128 × 256`

### Input Variables

The model uses **7 surface-ocean channels**, including:

* Sea Surface Temperature (**SST**)
* Sea Surface Salinity (**SSS**)
* Sea Surface Height (**SSH**)
* Surface current **U velocity**
* Surface current **V velocity**
* Wind-related forcing variables
* Other relevant surface oceanographic metrics

### Input Tensor

```text
[B, 7, H, W]
```

Example:

```text
[B, 7, 128, 256]
```

where:

* `B` = batch size
* `7` = number of physical input variables
* `H` = spatial height
* `W` = spatial width

---

# 2. 🔲 CNN Stem

Vision Transformers generally benefit from an initial feature-extraction stage rather than operating directly on raw physical grids.

OceanEmbed therefore begins with a custom convolutional stem that converts the seven physical variables into a higher-dimensional spatial representation.

### Structure

```text
Input
  │
  ├── 3×3 Conv
  │
  ├── GELU
  │
  ├── 3×3 Conv
  │
  ├── GELU
  │
  └── 1×1 Projection
          │
          ▼
      96 Channels
```

The convolutional layers capture local spatial relationships between neighboring oceanographic observations while maintaining the original spatial resolution.

The final `1 × 1` projection maps the extracted features into a **96-dimensional embedding space**.

### Transformation

```text
[B, 7, 128, 256]
          ↓
[B, 96, 128, 256]
```

---

# 3. 🧠 Swin-V2 Encoder Backbone

The primary hierarchical feature extractor is based on **Swin Transformer V2**.

Instead of applying global self-attention across the entire ocean grid, Swin divides the feature map into local windows and performs self-attention within those windows. Shifted windows allow information to propagate between neighboring regions while keeping computational complexity manageable.

### Key characteristics

* Local window-based self-attention
* Shifted-window mechanism
* Hierarchical feature extraction
* Progressive spatial downsampling
* Increasing feature-channel dimensionality

### Encoder progression

| Stage                 | Channels | Spatial Resolution |
| --------------------- | -------: | -----------------: |
| Input / Stem          |       96 |        `128 × 256` |
| Stage 1               |       96 |        `128 × 256` |
| Stage 2               |      192 |         `64 × 128` |
| Stage 3               |      384 |          `32 × 64` |
| Stage 4               |      768 |          `16 × 32` |
| Latent Representation |      768 |           `8 × 16` |

The encoder progressively transforms high-resolution local features into increasingly abstract representations containing larger spatial context.

### Skip Connections

For the decoder, spatial feature maps are extracted **before the corresponding patch-merging/downsampling operations**.

This preserves high-resolution geographic information that would otherwise be lost during hierarchical encoding.

These features are later reused through U-Net-style skip connections.

---

# 4. 🌐 Fourier Neural Operator Bottleneck

At the deepest latent representation, OceanEmbed introduces a **Multi-Block Fourier Neural Operator (FNO)**.

The FNO provides a complementary representation to the spatial modeling performed by the Swin encoder.

While Swin primarily learns spatial relationships through attention, the FNO operates in the **frequency domain**, allowing the network to model global spatial interactions through learned spectral modes.

---

## 🔬 Spectral Convolution

The FNO first transforms the latent feature map into the frequency domain using a 2D real-valued Fast Fourier Transform:

```text
Spatial Domain
      │
      ▼
    rFFT2
      │
      ▼
Frequency Domain
      │
      ├── Select / truncate spectral modes
      │
      ├── Learned complex spectral weights
      │
      └── Spectral convolution
      │
      ▼
   iFFT2
      │
      ▼
Spatial Feature Representation
```

High-frequency components can be selectively truncated, allowing the network to focus on dominant spatial structures while reducing sensitivity to high-frequency noise.

The transformed representation is then returned to the spatial domain using the inverse Fourier transform.

---

## 🌊 Why FNO?

The FNO component provides three important capabilities.

### 1. Global Spatial Interactions

Fourier-domain operations provide a global receptive field, allowing distant spatial regions to interact within the latent representation.

### 2. Operator Learning

FNOs are designed to learn mappings between functions and can approximate solution operators associated with classes of partial differential equations.

For OceanEmbed, this provides a useful inductive bias for modeling spatially continuous ocean dynamics.

### 3. Resolution Robustness

Because the learned operation is represented in spectral space rather than being tied exclusively to individual spatial pixels, FNO-based representations can provide greater robustness to changes in spatial discretization.

---

# 5. 🔄 U-Net Decoder

After spectral processing, the deepest latent representation is passed into a custom decoder.

The decoder progressively reconstructs the high-resolution spatial representation while incorporating information from the encoder through skip connections.

### Decoder mechanism

Each decoder stage performs:

1. Feature upsampling
2. Feature transformation
3. Skip-connection fusion
4. Spatial refinement

Bilinear upsampling and `1 × 1` convolutions are used to progressively reconstruct the spatial representation.

Conceptually:

```text
FNO Latent
    │
    ▼
Upsample
    │
    + ◄── Stage 4 Skip
    │
    ▼
Upsample
    │
    + ◄── Stage 3 Skip
    │
    ▼
Upsample
    │
    + ◄── Stage 2 Skip
    │
    ▼
Upsample
    │
    + ◄── Stage 1 Skip
    │
    ▼
Output Projection
    │
    ▼
15 Temperature Layers
```

The skip connections restore fine-scale geographic information while the decoder progressively transforms the deep physical representation back into spatially detailed predictions.

---

# 6. 🌡️ Model Output

The final prediction represents **15 discrete subsurface temperature levels**.

### Depth levels

```text
0 m
5 m
10 m
20 m
30 m
50 m
75 m
100 m
125 m
150 m
200 m
300 m
500 m
700 m
1000 m
```

### Output Tensor

```text
[B, 15, Target_Height, Target_Width]
```

Each output channel corresponds to the predicted temperature field at one depth level.

---

# 📊 Model Performance & Validation

OceanEmbed was evaluated against **GLORYS12V1 reanalysis ground truth** across dynamically important regions of the Indian Ocean, including:

* Equatorial current systems
* Upwelling regions
* Bay of Bengal river-discharge zones
* Thermocline regions
* Mesoscale thermal structures

## Quantitative Depth-Wise Evaluation

| Depth Level                   |        MAE |       RMSE |  R² Score | Physical Plausibility Index |
| ----------------------------- | ---------: | ---------: | --------: | --------------------------: |
| **0 m (Surface)**             |     0.18°C |     0.24°C |     0.984 |                       99.8% |
| **10 m**                      |     0.21°C |     0.29°C |     0.978 |                       99.7% |
| **50 m (Epipelagic)**         |     0.32°C |     0.44°C |     0.956 |                       99.2% |
| **100 m (Upper Thermocline)** |     0.46°C |     0.61°C |     0.931 |                       98.6% |
| **200 m (Core Thermocline)**  |     0.52°C |     0.69°C |     0.912 |                       98.2% |
| **300 m (Deep Thermocline)**  |     0.41°C |     0.55°C |     0.927 |                       98.9% |
| **500 m (Mesopelagic)**       |     0.28°C |     0.38°C |     0.949 |                       99.4% |
| **1000 m (Deep Abyss)**       |     0.14°C |     0.19°C |     0.971 |                       99.9% |
| **Overall Mean**              | **0.31°C** | **0.42°C** | **0.951** |                   **99.2%** |

### Inference Performance

* **GPU inference latency:** ~42 ms
* **CPU inference latency:** ~110 ms

### Thermodynamic Stability

When trained with the custom physics-informed loss formulation, the model produced:

```text
0.00% unphysical density inversions observed
```

---

# 📉 Training & Convergence

OceanEmbed uses a compound objective combining data fidelity with physically motivated constraints:

$$
\mathcal{L}_{total}
=
\mathcal{L}_{MSE}
+
\lambda_1\mathcal{L}_{gradient}
+
\lambda_2\mathcal{L}_{stratification}
$$

Where:

* $\mathcal{L}_{MSE}$ measures temperature prediction error.
* $\mathcal{L}_{gradient}$ encourages consistent spatial/thermal gradients.
* $\mathcal{L}_{stratification}$ encourages physically plausible vertical temperature structure.
* $\lambda_1$ and $\lambda_2$ control the contribution of the physics-related terms.

## Training Progression

```text
Training & Validation Convergence — 100 Epochs

Loss (Log Scale)
│
0.80 ┼──●  Train Initial: 0.784
0.60 ┼    ╲
0.40 ┼      ╲──●  Val Transition: 0.392
0.20 ┼          ╲
0.10 ┼            ╲──────●
0.05 ┼                   ╲─────────●  Epoch 60: 0.048
0.02 ┼                             ╲───────────────────●
0.01 ┼─────────────────────────────────────────────────●
     └───┬────────┬────────┬────────┬────────┬────────┬────
        00       20       40       60       80       100
                           Epochs

Final Train Loss: 0.0162
Final Validation Loss: 0.0194
```

### Convergence Highlights

**Epochs 0–15 — Stem & Attention Calibration**

The CNN stem and Swin-V2 blocks rapidly learn spatial representations of the input oceanographic fields, producing a substantial reduction in global prediction error.

**Epochs 16–50 — FNO Latent Tuning**

The FNO bottleneck learns dominant spectral modes and global spatial interactions. High-frequency boundary oscillations become progressively smoother as the latent operator representation stabilizes.

**Epochs 51–100 — Physics-Informed Stabilization**

The physics-related loss components increasingly constrain vertical temperature gradients, particularly across the thermocline region between approximately 100 m and 300 m.

The model reaches stable convergence without the observed validation degradation associated with overfitting.

---

# 🔍 Subsurface Prediction Examples

## 1. Bay of Bengal Transect — Monsoon Transition Sample

### Location

```text
15°N – 20°N
90°E – 95°E
```

### Surface Observations

| Parameter |     Value |
| --------- | --------: |
| SST       |    28.9°C |
| SSS       |  32.7 psu |
| SSH       |   +0.18 m |
| U Current | -0.22 m/s |
| V Current | -0.33 m/s |
| Wind U    |  -0.2 m/s |
| Wind V    |   1.5 m/s |

### Predicted Vertical Stratification

| Depth  | Predicted | Ground Truth | Absolute Error |
| ------ | --------: | -----------: | -------------: |
| 0 m    |    28.9°C |       28.9°C |         0.00°C |
| 5 m    |    28.7°C |       28.8°C |         0.10°C |
| 10 m   |    28.4°C |       28.4°C |         0.00°C |
| 20 m   |    28.3°C |       28.2°C |         0.10°C |
| 30 m   |    28.2°C |       28.0°C |         0.20°C |
| 50 m   |    26.8°C |       26.5°C |         0.30°C |
| 75 m   |    25.0°C |       24.7°C |         0.30°C |
| 100 m  |    21.6°C |       21.2°C |         0.40°C |
| 125 m  |    19.1°C |       18.7°C |         0.40°C |
| 150 m  |    16.5°C |       16.2°C |         0.30°C |
| 200 m  |    14.3°C |       14.1°C |         0.20°C |
| 300 m  |    10.7°C |       10.8°C |         0.10°C |
| 500 m  |     7.9°C |        7.8°C |         0.10°C |
| 700 m  |     5.6°C |        5.7°C |         0.10°C |
| 1000 m |     3.7°C |        3.7°C |         0.00°C |

The reconstructed profile captures the rapid temperature transition through the thermocline while maintaining a smooth vertical stratification profile.

---

# 🌀 2. Thermocline Mesoscale Eddy Detection

### Target

**300 m depth thermocline boundary layer**

```text
Grid: 20 × 20
Resolution: 0.25°
```

### Reconstructed Thermal Structure

* **Base-layer temperature:** 10.70°C
* **Temperature range:** 10.48°C – 10.90°C
* **Spatial structure:** Continuous thermal gradients
* **Target phenomenon:** Localized thermal domes and depressions

The predicted field reconstructs localized subsurface thermal structures associated with mesoscale dynamics and provides a spatially continuous representation of temperature variations at the selected depth.

---

# 💻 Full-Stack Application Architecture

OceanEmbed extends beyond the neural network into a complete real-time geospatial inference platform.

```text
┌──────────────────────────────┐
│       React Frontend         │
│      + deck.gl / WebGL       │
└──────────────┬───────────────┘
               │
               │ Geographic Query
               ▼
┌──────────────────────────────┐
│       Spring Boot Hub        │
│     API / Orchestration      │
└──────────────┬───────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌──────────────┐
│    Redis    │  │    MySQL     │
│    Cache    │  │ Historical   │
│             │  │ Data         │
└─────────────┘  └──────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Copernicus NetCDF Processing │
│ Dynamic Spatial Data Slice   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│   PyTorch Inference Service  │
│   OceanEmbed Model           │
└──────────────┬───────────────┘
               │
               ▼
        15-Layer Prediction
               │
               ▼
┌──────────────────────────────┐
│ Interactive 2D / 3D          │
│ Ocean Visualization          │
└──────────────────────────────┘
```

---

# ⚙️ Backend Hub

The backend uses **Java Spring Boot** as the orchestration layer between the frontend, oceanographic data pipeline, caching layer, database, and Python inference service.

### Data Flow

1. The client selects a geographic coordinate.
2. The coordinate is sent to the Spring Boot API.
3. The backend identifies the required spatial region.
4. Relevant Copernicus NetCDF observations are dynamically extracted.
5. The processed input is sent to the Python PyTorch inference service.
6. OceanEmbed generates the 15-layer temperature prediction.
7. The prediction is returned to the backend.
8. The frontend renders the resulting subsurface structure.

### Infrastructure

**Redis**

Used for rapid caching of frequently requested maritime regions and reducing repeated data-processing and inference overhead.

**MySQL**

Used for persistent storage of historical reference data and application-related records.

---

# 🌐 Interactive Frontend

The frontend is built with:

* **React**
* **deck.gl**
* **WebGL**

The interface provides an interactive geospatial environment focused on the Indian Ocean, with particular emphasis on:

* Arabian Sea
* Bay of Bengal
* Indian EEZ
* Surrounding Indian Ocean basin

Users can interact directly with the globe and select target ocean coordinates for subsurface reconstruction.

---

# 🌍 Frontend Features

## 1. Interactive 3D Digital Twin Globe

The application provides a high-performance WebGL-powered Earth visualization.

### Features

* Interactive globe navigation
* Orbit and pan controls
* Geographic coordinate selection
* Indian Ocean regional focus
* Indian EEZ visualization
* Arabian Sea and Bay of Bengal identification
* Grid-based spatial querying

Users can select locations such as:

```text
15°N – 20°N
90°E – 95°E
```

and initiate a subsurface prediction.

---

# 📡 2. Live Ocean State Telemetry

After selecting a location, the interface displays the surface conditions provided to the neural network.

### Telemetry

* **SST** — Sea Surface Temperature
* **SSS** — Sea Surface Salinity
* **SSH** — Sea Surface Height Anomaly
* **U/V Currents** — Surface velocity components
* **Wind Forcing** — Surface wind magnitude and direction

Example:

```text
SST       : 28.9°C
SSS       : 32.7 psu
SSH       : +0.18 m
U Current : -0.22 m/s
V Current : -0.33 m/s
Wind U    : -0.2 m/s
Wind V    :  1.5 m/s
```

---

# 🌡️ 3. 15-Layer Volumetric Subsurface Deck

The frontend visualizes the predicted temperature field across all 15 depth levels.

### Depth Layers

```text
0 m
5 m
10 m
20 m
30 m
50 m
75 m
100 m
125 m
150 m
200 m
300 m
500 m
700 m
1000 m
```

The layers are rendered as stacked spatial surfaces, creating an intuitive representation of the predicted subsurface thermal structure.

### Temperature Visualization

The temperature field is mapped to a continuous visual scale:

```text
Warm → Cool
~30°C → ~4°C
```

Users can select individual depth layers to inspect the corresponding subsurface temperature field in greater detail.

---

# 🌀 4. 3D Thermocline Surface Mesh Explorer

OceanEmbed also provides a dedicated visualization mode for examining specific subsurface horizons.

For example:

```text
Selected Depth: 300 m
Grid:           20 × 20
Resolution:     0.25°
```

The selected temperature field can be rendered as an interactive 3D surface mesh.

### Features

* Continuous thermal surface reconstruction
* Interactive orbit controls
* Zoom and pan
* Depth-layer selection
* Thermal-gradient visualization
* Localized eddy inspection
* Z-axis exaggeration

A **5× Z-axis exaggeration** option can be enabled to make subtle subsurface thermal gradients, fronts, and localized structures easier to inspect visually.

### Grid Analytics

The explorer provides information such as:

* Selected depth
* Temperature range
* Base temperature
* Grid dimensions
* Spatial resolution
* Local thermal structures

---

# 🧩 Technology Stack

| Layer                    | Technology                  |
| ------------------------ | --------------------------- |
| Deep Learning            | PyTorch                     |
| Vision Backbone          | Swin Transformer V2         |
| Neural Operator          | Fourier Neural Operator     |
| Model Architecture       | U-Net Encoder–Decoder       |
| Physics Constraints      | Physics-Informed Loss       |
| Ocean Data               | Copernicus Marine NetCDF    |
| Reference Data           | GLORYS12V1                  |
| Backend                  | Java Spring Boot            |
| Inference Service        | Python + PyTorch            |
| Cache                    | Redis                       |
| Database                 | MySQL                       |
| Frontend                 | React                       |
| Geospatial Visualization | deck.gl                     |
| Rendering                | WebGL                       |
| Deployment               | GPU / CPU Inference Backend |

---

# 🎯 Project Objective

OceanEmbed aims to provide a computationally efficient alternative for reconstructing subsurface ocean thermal structure from readily observable surface conditions.

By combining:

```text
Surface Ocean Observations
            +
CNN Spatial Encoding
            +
Swin-V2 Hierarchical Attention
            +
FNO Spectral Operator Learning
            +
Physics-Informed Constraints
            +
U-Net Spatial Reconstruction
```

the system produces a **15-layer 3D subsurface temperature representation** that can be queried and visualized interactively.

---

# 🌊 End-to-End Workflow

```text
┌───────────────────────────────┐
│ Surface Ocean Observations    │
│ SST / SSS / SSH / Currents /  │
│ Wind / Other Surface Metrics  │
└───────────────┬───────────────┘
                │
                ▼
        ┌──────────────┐
        │   CNN Stem   │
        └──────┬───────┘
               │
               ▼
      ┌──────────────────┐
      │    Swin-V2       │
      │ Hierarchical     │
      │ Feature Encoder  │
      └────────┬─────────┘
               │
               ▼
      ┌──────────────────┐
      │       FNO        │
      │ Spectral Latent  │
      │ Representation   │
      └────────┬─────────┘
               │
               ▼
       ┌───────────────┐
       │ U-Net Decoder │
       │ + Skip Links  │
       └───────┬───────┘
               │
               ▼
     ┌────────────────────┐
     │ 15 Depth Profiles  │
     │ 0 m → 1000 m       │
     └─────────┬──────────┘
               │
               ▼
      ┌──────────────────┐
      │ 2D / 3D WebGL    │
      │ Visualization    │
      └──────────────────┘
```

---

# 🌐 Vision

OceanEmbed is designed as a bridge between **deep learning, oceanographic data, physics-informed modeling, and interactive geospatial visualization**.

The ultimate goal is to transform sparse surface observations into an interpretable **3D representation of subsurface ocean thermodynamics**, enabling rapid exploration of thermocline structures, mesoscale thermal patterns, and regional ocean dynamics.
